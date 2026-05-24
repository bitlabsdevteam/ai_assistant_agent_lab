import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { buildExecutorPrompt } from "../llm/prompts.js";
import { AppError } from "../errors.js";
import { buildApprovalRequest } from "../policy/permissions.js";
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

    for (const step of input.analysis.plan) {
      if (completedSteps.has(step.id)) {
        continue;
      }

      const outcome = await this.executeStep(step, input.analysis, context);
      toolCalls.push(...outcome.records);
      outcome.changedFiles.forEach((file) => changedFiles.add(file));
      outcome.producedArtifacts.forEach((file) => producedArtifacts.add(file));
      blockers.push(...outcome.blockers);
      needsEvaluation = needsEvaluation || outcome.needsEvaluation;

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
  ): Promise<{
    success: boolean;
    records: ToolCallRecord[];
    changedFiles: string[];
    producedArtifacts: string[];
    blockers: string[];
    needsEvaluation: boolean;
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
    let observation = `Starting step '${step.title}'.`;

    await this.persistStepMemory(stepMemory, context);

    for (let actionIndex = 0; actionIndex < this.maxStepActions; actionIndex += 1) {
      const action = await this.chooseAction(step, analysis, context, observation, stepMemory);
      const trace = {
        stepId: step.id,
        observation: action.observation,
        chosenActionType: action.actionType,
        chosenActionName:
          action.actionType === "tool_call"
            ? action.toolName
            : action.actionType === "patch_proposal"
              ? PATCH_TOOL_NAME
              : action.actionType,
        rationaleSummary: action.rationaleSummary,
      } as const;
      context.stepTrace.push(trace);

      if (action.actionType === "clarification") {
        const message = action.clarificationQuestion;
        blockers.push(message);
        stepMemory.blockers.push(message);
        await this.persistStepMemory(stepMemory, context);
        await this.writeTranscript(context, step, actionIndex, action, { result: message });
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = message;
        }
        return { success: false, records, changedFiles, producedArtifacts, blockers, needsEvaluation: false };
      }

      if (action.actionType === "final_response") {
        await this.writeTranscript(context, step, actionIndex, action, { result: action.finalResponse });
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = action.finalResponse;
        }
        return { success: true, records, changedFiles, producedArtifacts, blockers, needsEvaluation: false };
      }

      if (action.actionType === "handoff_to_evaluator") {
        await this.writeTranscript(context, step, actionIndex, action, { result: action.handoffReason });
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = action.handoffReason;
        }
        return { success: true, records, changedFiles, producedArtifacts, blockers, needsEvaluation: true };
      }

      if (action.actionType === "patch_proposal") {
        const outcome = await this.handlePatchProposal(step, action.patch, context, stepMemory, actionIndex, action);
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
          return { success: false, records, changedFiles, producedArtifacts, blockers, needsEvaluation: false };
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

      const toolName = action.toolName;
      if (!step.toolNames.includes(toolName)) {
        const blocker = `Executor selected disallowed tool '${toolName}' for step '${step.title}'.`;
        blockers.push(blocker);
        stepMemory.blockers.push(blocker);
        await this.persistStepMemory(stepMemory, context);
        return { success: false, records, changedFiles, producedArtifacts, blockers, needsEvaluation: false };
      }

      const toolInput = await this.buildToolInput(toolName, step, analysis, context, action.toolInput);
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
        },
        context.artifactStore,
        context.policy,
        { stepId: step.id },
      );
      context.budget.toolCallsUsed += 1;
      const transcriptArtifact = await this.writeTranscript(context, step, actionIndex, action, {
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
        return { success: false, records, changedFiles, producedArtifacts, blockers, needsEvaluation: false };
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
        return { success: false, records, changedFiles, producedArtifacts, blockers, needsEvaluation: false };
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
    return { success: false, records, changedFiles, producedArtifacts, blockers, needsEvaluation: false };
  }

  private async chooseAction(
    step: PlanStep,
    analysis: AnalysisResult,
    context: AgentRuntimeContext,
    observation: string,
    stepMemory: ExecutorStepMemory,
  ): Promise<ExecutorAction> {
    const prompt = buildExecutorPrompt(analysis, step, context.contextSnapshot, observation, stepMemory);
    const response = await context.llm.generateObject(
      {
        role: "executor",
        prompt,
        input: {
          analysis,
          step,
          observation,
          stepMemory,
          operatorMode: context.operatorMode ?? "full-auto",
        },
      },
      ExecutorActionSchema,
    );
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
  if (!overrideInput || Object.keys(overrideInput).length === 0) {
    return {};
  }
  const normalized = Object.fromEntries(
    Object.entries(overrideInput).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  );
  if ("createDirectories" in normalized) {
    normalized.createDirectories = Boolean(normalized.createDirectories);
  }
  if ("recursive" in normalized) {
    normalized.recursive = Boolean(normalized.recursive);
  }
  return normalized;
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
