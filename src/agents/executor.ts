import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  buildExecutorPromptEnvelope,
  buildPromptArtifactRecord,
  renderPromptEnvelopeForTransport,
} from "../llm/prompts.js";
import { AppError } from "../errors.js";
import { buildApprovalRequest } from "../policy/permissions.js";
import { preparePromptWithTokenBudget } from "./llm-preflight.js";
import type {
  AnalysisResult,
  ExecutionReport,
  ExecutorAction,
  ExecutorStepMemory,
  PatchProposal,
  PlanStep,
  ToolCallRecord,
} from "../schemas.js";
import { ExecutionReportSchema, ExecutorActionSchema, ExecutorStepMemorySchema } from "../schemas.js";
import type { Agent, AgentRuntimeContext } from "./base.js";

export interface ExecutorInput {
  analysis: AnalysisResult;
  priorExecution?: ExecutionReport;
}

const PATCH_TOOL_NAME = "patch.apply";

export class ExecutorAgent implements Agent<ExecutorInput, ExecutionReport> {
  public readonly name = "executor";
  private readonly maxStepActions = 5;

  public async run(input: ExecutorInput, context: AgentRuntimeContext): Promise<ExecutionReport> {
    const completedSteps = new Set(input.priorExecution?.completedSteps ?? []);
    const skippedSteps = new Set<string>();
    const toolCalls: ToolCallRecord[] = [...(input.priorExecution?.toolCalls ?? [])];
    const changedFiles = new Set(input.priorExecution?.changedFiles ?? []);
    const producedArtifacts = new Set(input.priorExecution?.producedArtifacts ?? []);
    const blockers: string[] = [];
    let needsEvaluation = false;
    let assistantResponse = input.priorExecution?.assistantResponse;
    let latestObservation = "Starting execution.";

    for (const step of input.analysis.plan) {
      if (completedSteps.has(step.id)) {
        continue;
      }

      const outcome = await this.executeStep(step, input.analysis, context, latestObservation);
      toolCalls.push(...outcome.records);
      outcome.changedFiles.forEach((file) => changedFiles.add(file));
      outcome.producedArtifacts.forEach((file) => producedArtifacts.add(file));
      blockers.push(...outcome.blockers);
      needsEvaluation = needsEvaluation || outcome.needsEvaluation;
      if (outcome.assistantResponse) {
        assistantResponse = outcome.assistantResponse;
      }
      latestObservation = outcome.finalObservation;

      if (outcome.success) {
        completedSteps.add(step.id);
      } else {
        skippedSteps.add(step.id);
      }

      if (!outcome.success || outcome.needsEvaluation) {
        break;
      }
    }

    await context.artifactStore.writeJson("tool-calls.json", toolCalls);
    await context.artifactStore.writeJson("changed-files.json", [...changedFiles]);

    return ExecutionReportSchema.parse({
      completedSteps: [...completedSteps],
      skippedSteps: [...skippedSteps],
      toolCalls,
      changedFiles: [...changedFiles],
      producedArtifacts: [...producedArtifacts],
      blockers,
      needsEvaluation,
      ...(assistantResponse ? { assistantResponse } : {}),
      summary:
        blockers.length === 0
          ? needsEvaluation
            ? "Execution paused for evaluator handoff."
            : `Executed ${completedSteps.size} plan steps successfully.`
          : `Execution completed with ${blockers.length} blocker(s).`,
    });
  }

  private async executeStep(
    step: PlanStep,
    analysis: AnalysisResult,
    context: AgentRuntimeContext,
    initialObservation?: string,
  ): Promise<{
    success: boolean;
    records: ToolCallRecord[];
    changedFiles: string[];
    producedArtifacts: string[];
    blockers: string[];
    needsEvaluation: boolean;
    assistantResponse?: string;
    finalObservation: string;
  }> {
    const records: ToolCallRecord[] = [];
    const changedFiles: string[] = [];
    const producedArtifacts: string[] = [];
    const blockers: string[] = [];
    const stepMemory = ExecutorStepMemorySchema.parse({
      stepId: step.id,
      objective: `${analysis.objective} :: ${step.title}`,
      remainingSuccessCriteria: [...analysis.successCriteria],
    });
    let observation = initialObservation ?? `Starting step '${step.title}'.`;

    await this.persistStepMemory(stepMemory, context);

    for (let actionIndex = 0; actionIndex < this.maxStepActions; actionIndex += 1) {
      const action =
        records.length === 0 ? this.buildApprovedReplayAction(step, context, observation) : undefined;
      const resolvedAction = action ?? (await this.chooseAction(step, analysis, context, observation, stepMemory));
      const trace = {
        stepId: step.id,
        observation: resolvedAction.observation,
        chosenActionType: resolvedAction.actionType,
        chosenActionName:
          resolvedAction.actionType === "tool_call"
            ? resolvedAction.toolName
            : resolvedAction.actionType === "patch_proposal"
              ? PATCH_TOOL_NAME
              : resolvedAction.actionType,
        rationaleSummary: resolvedAction.rationaleSummary,
      } as const;
      context.stepTrace.push(trace);

      if (resolvedAction.actionType === "clarification") {
        const message = resolvedAction.clarificationQuestion;
        blockers.push(message);
        stepMemory.blockers.push(message);
        await this.persistStepMemory(stepMemory, context);
        await this.writeTranscript(context, step, actionIndex, resolvedAction, { result: message });
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = message;
        }
        return {
          success: false,
          records,
          changedFiles,
          producedArtifacts,
          blockers,
          needsEvaluation: false,
          finalObservation: message,
        };
      }

      if (resolvedAction.actionType === "final_response") {
        await this.writeTranscript(context, step, actionIndex, resolvedAction, { result: resolvedAction.finalResponse });
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = resolvedAction.finalResponse;
        }
        return {
          success: true,
          records,
          changedFiles,
          producedArtifacts,
          blockers,
          needsEvaluation: false,
          assistantResponse: resolvedAction.finalResponse,
          finalObservation: resolvedAction.finalResponse,
        };
      }

      if (resolvedAction.actionType === "handoff_to_evaluator") {
        await this.writeTranscript(context, step, actionIndex, resolvedAction, { result: resolvedAction.handoffReason });
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = resolvedAction.handoffReason;
        }
        return {
          success: true,
          records,
          changedFiles,
          producedArtifacts,
          blockers,
          needsEvaluation: true,
          finalObservation: resolvedAction.handoffReason,
        };
      }

      if (resolvedAction.actionType === "patch_proposal") {
        const outcome = await this.handlePatchProposal(
          step,
          resolvedAction.patch,
          context,
          stepMemory,
          actionIndex,
          resolvedAction,
        );
        records.push(outcome.record);
        producedArtifacts.push(...outcome.producedArtifacts);
        if (outcome.changedFile) {
          changedFiles.push(outcome.changedFile);
        }
        if (outcome.blocker) {
          blockers.push(outcome.blocker);
          stepMemory.blockers.push(outcome.blocker);
          await this.persistStepMemory(stepMemory, context);
          const latestTrace = context.stepTrace.at(-1);
          if (latestTrace) {
            latestTrace.resultSummary = outcome.blocker;
          }
          return {
            success: false,
            records,
            changedFiles,
            producedArtifacts,
            blockers,
            needsEvaluation: false,
            finalObservation: outcome.blocker,
          };
        }
        observation = outcome.summary;
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = outcome.summary;
        }
        stepMemory.remainingSuccessCriteria = pruneSatisfiedCriteria(stepMemory.remainingSuccessCriteria, step);
        await this.persistStepMemory(stepMemory, context);
        continue;
      }

      const toolName = resolvedAction.toolName;
      if (!step.toolNames.includes(toolName)) {
        const blocker = `Executor selected disallowed tool '${toolName}' for step '${step.title}'.`;
        blockers.push(blocker);
        stepMemory.blockers.push(blocker);
        await this.persistStepMemory(stepMemory, context);
        return {
          success: false,
          records,
          changedFiles,
          producedArtifacts,
          blockers,
          needsEvaluation: false,
          finalObservation: blocker,
        };
      }

      const toolInput = await this.buildToolInput(toolName, step, analysis, context, resolvedAction.toolInput);
      const outcome = await context.tools.invoke(
        toolName,
        toolInput,
        {
          runId: context.runId,
          workingDirectory: context.workingDirectory,
          dryRun: context.dryRun,
          permissions: context.permissions,
          signal: context.signal,
          settings: context.settings,
          artifactStore: context.artifactStore,
          policy: context.policy,
          approvals: context.approvals,
          ...(context.operatorMode ? { operatorMode: context.operatorMode } : {}),
          ...(context.onTelemetryEvent ? { onTelemetryEvent: context.onTelemetryEvent } : {}),
        },
        context.artifactStore,
        context.policy,
        { stepId: step.id },
      );
      context.budget.toolCallsUsed += 1;
      const transcriptArtifact = await this.writeTranscript(context, step, actionIndex, resolvedAction, {
        input: toolInput,
        record: outcome.record,
      });
      outcome.record.transcriptArtifact = transcriptArtifact;
      records.push(outcome.record);

      if (outcome.record.outputArtifact) {
        producedArtifacts.push(outcome.record.outputArtifact);
      }
      if (outcome.record.diffArtifact) {
        producedArtifacts.push(outcome.record.diffArtifact);
        stepMemory.appliedDiffArtifacts.push(outcome.record.diffArtifact);
      }
      if (toolName === "fs.read") {
        const readResult = outcome.result as { path?: string; content?: string } | undefined;
        stepMemory.filesInspected.push(
          JSON.stringify({
            path: readResult?.path ?? (toolInput as { path?: string }).path ?? "",
            content: readResult?.content ?? "",
          }),
        );
      } else if (toolName === "fs.list") {
        stepMemory.filesInspected.push(JSON.stringify(toolInput));
      }
      if (toolName === "shell.exec" || toolName === "validation.run") {
        stepMemory.commandOutputs.push(outcome.record.stdoutSummary ?? outcome.record.inputSummary);
      }
      if (outcome.approvalRequest) {
        await context.approvalManager.add(outcome.approvalRequest);
        context.approvals = context.approvalManager.snapshot();
        const blocker = outcome.approvalRequest.reason;
        blockers.push(blocker);
        stepMemory.blockers.push(blocker);
        await this.persistStepMemory(stepMemory, context);
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = blocker;
        }
        return {
          success: false,
          records,
          changedFiles,
          producedArtifacts,
          blockers,
          needsEvaluation: false,
          finalObservation: blocker,
        };
      }
      if (outcome.record.status !== "success") {
        const blocker = outcome.record.error ?? `Tool '${toolName}' failed.`;
        blockers.push(blocker);
        stepMemory.blockers.push(blocker);
        await this.persistStepMemory(stepMemory, context);
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = blocker;
        }
        return {
          success: false,
          records,
          changedFiles,
          producedArtifacts,
          blockers,
          needsEvaluation: false,
          finalObservation: blocker,
        };
      }
      if (toolName === "fs.write") {
        const writeInput = toolInput as { path: string };
        changedFiles.push(resolveTarget(context.workingDirectory, writeInput.path));
      }
      observation = outcome.record.stdoutSummary ?? `Tool '${toolName}' completed successfully.`;
      stepMemory.remainingSuccessCriteria = pruneSatisfiedCriteria(stepMemory.remainingSuccessCriteria, step);
      await this.persistStepMemory(stepMemory, context);
      const latestTrace = context.stepTrace.at(-1);
      if (latestTrace) {
        latestTrace.resultSummary = observation;
      }
    }

    const blocker = `Executor exhausted action budget for step '${step.title}'.`;
    blockers.push(blocker);
    stepMemory.blockers.push(blocker);
    await this.persistStepMemory(stepMemory, context);
    return {
      success: false,
      records,
      changedFiles,
      producedArtifacts,
      blockers,
      needsEvaluation: false,
      finalObservation: blocker,
    };
  }

  private buildApprovedReplayAction(
    step: PlanStep,
    context: AgentRuntimeContext,
    observation: string,
  ): ExecutorAction | undefined {
    const approved = [...context.approvals]
      .reverse()
      .find(
        (approval) =>
          approval.status === "approved" &&
          approval.stepId === step.id &&
          step.toolNames.includes(approval.toolName) &&
          approval.input !== undefined,
      );
    if (!approved) {
      return undefined;
    }
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation,
      actionType: "tool_call",
      toolName: approved.toolName,
      toolInput: toToolInputEntries(normalizeApprovalInput(approved.input)),
      rationaleSummary: "Replay the exact approved tool input before asking the model to re-plan the step.",
    });
  }

  private async chooseAction(
    step: PlanStep,
    analysis: AnalysisResult,
    context: AgentRuntimeContext,
    observation: string,
    stepMemory: ExecutorStepMemory,
  ): Promise<ExecutorAction> {
    const llmInput = {
      analysis,
      step,
      observation,
      stepMemory,
      operatorMode: context.operatorMode ?? "full-auto",
    };
    const promptPreparation = await preparePromptWithTokenBudget({
      role: "executor",
      llmInput,
      schema: ExecutorActionSchema,
      context,
      buildPrompt: (compactionMode) =>
        buildExecutorPromptEnvelope(
          context.runRequest ?? {
            task: analysis.objective,
            workingDirectory: context.workingDirectory,
            profile: "default",
            dryRun: context.dryRun,
            maxIterations: context.budget.maxIterations,
            selectedSkills: [],
            metadata: {},
          },
          analysis,
          step,
          context.contextSnapshot,
          observation,
          stepMemory,
          {
            dryRun: context.dryRun,
            permissions: context.permissions,
            approvalMode: context.settings.approvalMode,
            ...(context.operatorMode ? { operatorMode: context.operatorMode } : {}),
          },
          compactionMode,
        ),
    });
    const prompt = promptPreparation.prompt;
    await context.artifactStore.writeJson(
      `prompt-envelope-executor-${step.id}.json`,
      {
        envelope: prompt,
        transport: renderPromptEnvelopeForTransport(prompt, llmInput),
      },
      {
        confidentiality: "metadata_only",
        metadata: buildPromptArtifactRecord(prompt),
      },
    );
    const response = await context.llm.generateObject(
      {
        role: "executor",
        prompt,
        input: llmInput,
        ...(context.onLLMEvent
          ? {
              stream: {
                onTextDelta: (delta) =>
                  context.onLLMEvent?.({
                    role: "executor",
                    type: "response.output_text.delta",
                    delta,
                    stepId: step.id,
                    stepTitle: step.title,
                    stepHasTools: step.toolNames.length > 0,
                  }),
                onEvent: (event) =>
                  context.onLLMEvent?.({
                    role: "executor",
                    stepId: step.id,
                    stepTitle: step.title,
                    stepHasTools: step.toolNames.length > 0,
                    ...event,
                  }),
              },
            }
          : {}),
      },
      ExecutorActionSchema,
    );
    await context.usageTracker.record({
      phase: "executor",
      provider: promptPreparation.count.provider,
      model: response.model,
      contextWindowTokens: response.contextWindowTokens ?? promptPreparation.count.contextWindowTokens,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      totalTokens: response.totalTokens,
      cachedInputTokens: response.cachedInputTokens,
      reasoningOutputTokens: response.reasoningOutputTokens,
      promptChars: response.promptChars,
      stage: "response",
      compactionMode: promptPreparation.compactionMode,
    });
    context.budget.promptCharsUsed += response.promptChars;
    context.budget.estimatedCostUsd += response.estimatedCostUsd;
    return ExecutorActionSchema.parse(response.object);
  }

  private async buildToolInput(
    toolName: string,
    step: PlanStep,
    analysis: AnalysisResult,
    context: AgentRuntimeContext,
    overrideInput?: Extract<ExecutorAction, { actionType: "tool_call" }>["toolInput"],
  ): Promise<unknown> {
    const normalizedOverride = normalizeToolInputOverride(overrideInput);
    const task = analysis.objective;
    if (toolName === "fs.list") {
      return {
        path: ".",
        recursive: false,
        ...normalizedOverride,
      };
    }
    if (toolName === "fs.read") {
      const match = task.match(/to\s+(.+)/i) ?? task.match(/file\s+(.+?)\s+/i);
      return {
        path: match?.[1]?.trim() ?? ".",
        ...normalizedOverride,
      };
    }
    if (toolName === "fs.write") {
      const createMatch = task.match(/create file\s+(.+?)\s+with content\s+([\s\S]+)/i);
      if (createMatch?.[1] && createMatch[2]) {
        return {
          path: createMatch[1].trim(),
          content: createMatch[2],
          createDirectories: true,
          ...normalizedOverride,
        };
      }
      const appendMatch = task.match(/append\s+([\s\S]+)\s+to\s+(.+)/i);
      if (appendMatch?.[1] && appendMatch[2]) {
        const targetPath = appendMatch[2].trim();
        const absolute = resolveTarget(context.workingDirectory, targetPath);
        const current = (await readTextIfExists(absolute)) ?? "";
        return {
          path: targetPath,
          content: `${current}${appendMatch[1]}`,
          createDirectories: true,
          ...normalizedOverride,
        };
      }
      throw new AppError("VALIDATION_ERROR", `No deterministic fs.write mapping exists for step '${step.title}'.`);
    }
    if (toolName === "web.search") {
      return {
        query: step.description || analysis.objective,
        maxResults: 5,
        ...normalizedOverride,
      };
    }
    if (Object.keys(normalizedOverride).length > 0) {
      return normalizedOverride;
    }
    throw new AppError("VALIDATION_ERROR", `No deterministic tool input builder for ${toolName}.`);
  }

  private async handlePatchProposal(
    step: PlanStep,
    patch: PatchProposal,
    context: AgentRuntimeContext,
    stepMemory: ExecutorStepMemory,
    actionIndex: number,
    action: Extract<ExecutorAction, { actionType: "patch_proposal" }>,
  ): Promise<{
    record: ToolCallRecord;
    changedFile?: string;
    producedArtifacts: string[];
    blocker?: string;
    summary: string;
  }> {
    if (!step.toolNames.includes("fs.write") && !step.toolNames.includes("fs.patch")) {
      return {
        record: {
          id: `${context.runId}-${PATCH_TOOL_NAME}-${Date.now()}`,
          toolName: PATCH_TOOL_NAME,
          category: "edit",
          stepId: step.id,
          inputSummary: JSON.stringify(patch),
          status: "denied",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          cwd: context.workingDirectory,
          approvalProvenance: "denied",
          error: `Patch proposal is not allowed for step '${step.title}'.`,
        },
        producedArtifacts: [],
        blocker: `Patch proposal is not allowed for step '${step.title}'.`,
        summary: `Patch proposal denied for ${patch.path}.`,
      };
    }

    const target = resolveTarget(context.workingDirectory, patch.path);
    context.policy.ensurePathAllowed(target);
    const current = (await readTextIfExists(target)) ?? "";
    const desiredContent =
      patch.reason.toLowerCase().includes("append") && current.length > 0 && !patch.updatedContent.startsWith(current)
        ? `${current}${patch.updatedContent}`
        : patch.updatedContent;
    const currentHash = hashContent(current);
    const diff = buildSimpleDiff(current, desiredContent);
    const artifactBase = `${sanitizeArtifactSegment(step.id)}-${sanitizeArtifactSegment(path.basename(target))}-${Date.now()}`;
    const proposedArtifact = await context.artifactStore.writeArtifactText(`${artifactBase}-proposed.patch`, diff);
    stepMemory.proposedDiffArtifacts.push(proposedArtifact);
    await this.persistStepMemory(stepMemory, context);

    const approvalInput = {
      path: patch.path,
      updatedContent: desiredContent,
      baseHash: currentHash,
    };
    const patchDescriptor = {
      name: PATCH_TOOL_NAME,
      description: "Apply a reviewed patch proposal.",
      category: "edit" as const,
      riskLevel: "medium" as const,
      sideEffecting: true,
      requiresApproval: true,
      dryRunSafe: true,
      permissionScope: "workspace" as const,
    };
    const startedAt = new Date().toISOString();
    const decision = context.policy.decideTool(
      patchDescriptor,
      approvalInput,
      undefined,
      context.operatorMode,
      context.approvals,
    );

    if (decision.outcome === "require_approval") {
      const approvalRequest = buildApprovalRequest(
        context.runId,
        patchDescriptor,
        `Apply patch to ${patch.path}`,
        approvalInput,
        "Patch proposal requires approval.",
        decision.riskLevel,
        {
          stepId: step.id,
          target: patch.path,
        },
      );
      await context.approvalManager.add(approvalRequest);
      context.approvals = context.approvalManager.snapshot();
      const record: ToolCallRecord = {
        id: `${context.runId}-${PATCH_TOOL_NAME}-${Date.now()}`,
        toolName: PATCH_TOOL_NAME,
        category: "edit",
        stepId: step.id,
        inputSummary: JSON.stringify(approvalInput),
        status: "skipped",
        startedAt,
        completedAt: new Date().toISOString(),
        cwd: context.workingDirectory,
        approvalProvenance: "pending",
        diffArtifact: proposedArtifact,
        error: approvalRequest.reason,
      };
      record.transcriptArtifact = await this.writeTranscript(context, step, actionIndex, action, { record });
      return {
        record,
        producedArtifacts: [proposedArtifact],
        blocker: approvalRequest.reason,
        summary: `Patch for ${patch.path} proposed and awaiting approval.`,
      };
    }

    if (decision.outcome === "deny") {
      const rejectedArtifact = await context.artifactStore.writeArtifactText(`${artifactBase}-rejected.patch`, diff);
      const record: ToolCallRecord = {
        id: `${context.runId}-${PATCH_TOOL_NAME}-${Date.now()}`,
        toolName: PATCH_TOOL_NAME,
        category: "edit",
        stepId: step.id,
        inputSummary: JSON.stringify(approvalInput),
        status: "denied",
        startedAt,
        completedAt: new Date().toISOString(),
        cwd: context.workingDirectory,
        approvalProvenance: "denied",
        diffArtifact: rejectedArtifact,
        error: decision.reason,
      };
      record.transcriptArtifact = await this.writeTranscript(context, step, actionIndex, action, { record });
      return {
        record,
        producedArtifacts: [proposedArtifact, rejectedArtifact],
        blocker: decision.reason,
        summary: `Patch for ${patch.path} was denied.`,
      };
    }

    const latestContent = (await readTextIfExists(target)) ?? "";
    if (hashContent(latestContent) !== currentHash) {
      const rejectedArtifact = await context.artifactStore.writeArtifactText(`${artifactBase}-rejected.patch`, diff);
      const blocker = `Patch proposal for '${patch.path}' became stale before apply. Re-plan required.`;
      const record: ToolCallRecord = {
        id: `${context.runId}-${PATCH_TOOL_NAME}-${Date.now()}`,
        toolName: PATCH_TOOL_NAME,
        category: "edit",
        stepId: step.id,
        inputSummary: JSON.stringify(approvalInput),
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        cwd: context.workingDirectory,
        approvalProvenance: "approved",
        diffArtifact: rejectedArtifact,
        error: blocker,
      };
      record.transcriptArtifact = await this.writeTranscript(context, step, actionIndex, action, { record });
      return {
        record,
        producedArtifacts: [proposedArtifact, rejectedArtifact],
        blocker,
        summary: blocker,
      };
    }

    if (!context.dryRun) {
      if (patch.createIfMissing) {
        await mkdir(path.dirname(target), { recursive: true });
      } else {
        try {
          await access(path.dirname(target), fsConstants.R_OK);
        } catch {
          await mkdir(path.dirname(target), { recursive: true });
        }
      }
      await writeFile(target, desiredContent, "utf8");
    }
    const appliedArtifact = await context.artifactStore.writeArtifactText(`${artifactBase}-applied.patch`, diff);
    context.budget.toolCallsUsed += 1;
    const summary =
      current === desiredContent
        ? `Patch for ${patch.path} was a no-op.`
        : context.dryRun
          ? `Patch for ${patch.path} prepared in dry-run mode.`
          : `Patch for ${patch.path} applied successfully.`;
    const record: ToolCallRecord = {
      id: `${context.runId}-${PATCH_TOOL_NAME}-${Date.now()}`,
      toolName: PATCH_TOOL_NAME,
      category: "edit",
      stepId: step.id,
      inputSummary: JSON.stringify(approvalInput),
      status: "success",
      startedAt,
      completedAt: new Date().toISOString(),
      cwd: context.workingDirectory,
      approvalProvenance: decision.reason.includes("approval") ? "approved" : "policy_allowed",
      diffArtifact: appliedArtifact,
      outputArtifact: appliedArtifact,
      stdoutSummary: summary,
    };
    record.transcriptArtifact = await this.writeTranscript(context, step, actionIndex, action, { record });
    stepMemory.appliedDiffArtifacts.push(appliedArtifact);
    return {
      record,
      producedArtifacts: [proposedArtifact, appliedArtifact],
      changedFile: target,
      summary,
    };
  }

  private async persistStepMemory(stepMemory: ExecutorStepMemory, context: AgentRuntimeContext): Promise<void> {
    await context.artifactStore.writeArtifactJson(`step-memory-${sanitizeArtifactSegment(stepMemory.stepId)}.json`, stepMemory);
  }

  private async writeTranscript(
    context: AgentRuntimeContext,
    step: PlanStep,
    actionIndex: number,
    action: ExecutorAction,
    result: Record<string, unknown>,
  ): Promise<string> {
    return context.artifactStore.appendJsonl("executor-transcript.jsonl", {
      timestamp: new Date().toISOString(),
      stepId: step.id,
      stepTitle: step.title,
      actionIndex,
      action,
      result,
    });
  }
}

function normalizeToolInputOverride(
  overrideInput?: Extract<ExecutorAction, { actionType: "tool_call" }>["toolInput"],
): Record<string, unknown> {
  if (!overrideInput || overrideInput.length === 0) {
    return {};
  }
  const normalized = Object.fromEntries(
    overrideInput.map(({ key, value }) => [key, Array.isArray(value) ? [...value] : value]),
  );
  if ("createDirectories" in normalized) {
    normalized.createDirectories = Boolean(normalized.createDirectories);
  }
  if ("recursive" in normalized) {
    normalized.recursive = Boolean(normalized.recursive);
  }
  return normalized;
}

function normalizeApprovalInput(input: unknown): Record<string, string | number | boolean | null | Array<string | number | boolean | null>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const normalized: Record<string, string | number | boolean | null | Array<string | number | boolean | null>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      (Array.isArray(value) &&
        value.every(
          (entry) =>
            typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null,
        ))
    ) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function toToolInputEntries(
  input: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>,
): Array<{ key: string; value: string | number | boolean | null | Array<string | number | boolean | null> }> {
  return Object.entries(input).map(([key, value]) => ({ key, value }));
}

function resolveTarget(workingDirectory: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.join(workingDirectory, targetPath);
}

async function readTextIfExists(target: string): Promise<string | undefined> {
  try {
    await access(target, fsConstants.R_OK);
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

function buildSimpleDiff(previousContent: string, nextContent: string): string {
  return ["--- before", "+++ after", ...renderDiffBody(previousContent, nextContent)].join("\n");
}

function renderDiffBody(previousContent: string, nextContent: string): string[] {
  const previousLines = previousContent.split("\n");
  const nextLines = nextContent.split("\n");
  const max = Math.max(previousLines.length, nextLines.length);
  const lines: string[] = [];
  for (let index = 0; index < max; index += 1) {
    const previous = previousLines[index];
    const next = nextLines[index];
    if (previous === next) {
      if (previous !== undefined) {
        lines.push(` ${previous}`);
      }
      continue;
    }
    if (previous !== undefined) {
      lines.push(`-${previous}`);
    }
    if (next !== undefined) {
      lines.push(`+${next}`);
    }
  }
  return lines;
}

function sanitizeArtifactSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9-_]+/g, "-");
}

function hashContent(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function pruneSatisfiedCriteria(criteria: string[], step: PlanStep): string[] {
  if (criteria.length === 0) {
    return criteria;
  }
  return criteria.filter((criterion) => !criterion.toLowerCase().includes(step.title.toLowerCase()));
}
