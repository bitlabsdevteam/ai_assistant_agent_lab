import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildExecutorPrompt } from "../llm/prompts.js";
import { AppError } from "../errors.js";
import type { AnalysisResult, ExecutionReport, ExecutorAction, PlanStep, ToolCallRecord } from "../schemas.js";
import { ExecutionReportSchema, ExecutorActionSchema } from "../schemas.js";
import type { Agent, AgentRuntimeContext } from "./base.js";

export interface ExecutorInput {
  analysis: AnalysisResult;
  priorExecution?: ExecutionReport;
}

export class ExecutorAgent implements Agent<ExecutorInput, ExecutionReport> {
  public readonly name = "executor";
  private readonly maxStepActions = 3;

  public async run(input: ExecutorInput, context: AgentRuntimeContext): Promise<ExecutionReport> {
    const completedSteps = new Set(input.priorExecution?.completedSteps ?? []);
    const skippedSteps = new Set<string>();
    const toolCalls: ToolCallRecord[] = [...(input.priorExecution?.toolCalls ?? [])];
    const changedFiles = new Set(input.priorExecution?.changedFiles ?? []);
    const producedArtifacts = new Set(input.priorExecution?.producedArtifacts ?? []);
    const blockers: string[] = [];

    for (const step of input.analysis.plan) {
      if (completedSteps.has(step.id)) {
        continue;
      }

      if (step.approvalRequired) {
        skippedSteps.add(step.id);
        blockers.push(`Approval required for step '${step.title}'.`);
        continue;
      }

      const outcome = await this.executeStep(step, input.analysis, context);
      toolCalls.push(...outcome.records);
      outcome.changedFiles.forEach((file) => changedFiles.add(file));
      outcome.producedArtifacts.forEach((file) => producedArtifacts.add(file));
      blockers.push(...outcome.blockers);

      if (outcome.success) {
        completedSteps.add(step.id);
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace && !latestTrace.resultSummary) {
          latestTrace.resultSummary = `Completed step '${step.title}'.`;
        }
      } else {
        skippedSteps.add(step.id);
      }
    }

    return ExecutionReportSchema.parse({
      completedSteps: [...completedSteps],
      skippedSteps: [...skippedSteps],
      toolCalls,
      changedFiles: [...changedFiles],
      producedArtifacts: [...producedArtifacts],
      blockers,
      summary:
        blockers.length === 0
          ? `Executed ${completedSteps.size} plan steps successfully.`
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
  }> {
    const records: ToolCallRecord[] = [];
    const changedFiles: string[] = [];
    const producedArtifacts: string[] = [];
    const blockers: string[] = [];
    let observation = `Starting step '${step.title}'.`;

    for (let actionIndex = 0; actionIndex < this.maxStepActions; actionIndex += 1) {
      const action = await this.chooseAction(step, analysis, context, observation);
      context.stepTrace.push({
        stepId: step.id,
        observation: action.observation,
        chosenActionType: action.actionType,
        chosenActionName:
          action.actionType === "tool_call"
            ? (action.toolName ?? "none")
            : action.actionType === "clarification"
              ? "clarification"
              : "final_response",
        rationaleSummary: action.rationaleSummary,
      });

      if (action.actionType === "clarification") {
        blockers.push(action.clarificationQuestion ?? `Clarification required for step '${step.title}'.`);
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = blockers.at(-1);
        }
        return { success: false, records, changedFiles, producedArtifacts, blockers };
      }

      if (action.actionType === "final_response") {
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = action.finalResponse ?? `Completed step '${step.title}'.`;
        }
        return { success: true, records, changedFiles, producedArtifacts, blockers };
      }

      const toolName = action.toolName;
      if (!toolName) {
        blockers.push(`Executor omitted a tool name for step '${step.title}'.`);
        return { success: false, records, changedFiles, producedArtifacts, blockers };
      }
      if (!step.toolNames.includes(toolName)) {
        blockers.push(`Executor selected disallowed tool '${toolName}' for step '${step.title}'.`);
        return { success: false, records, changedFiles, producedArtifacts, blockers };
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
        },
        context.artifactStore,
        context.policy,
        { stepId: step.id },
      );
      records.push(outcome.record);
      context.budget.toolCallsUsed += 1;
      if (outcome.record.outputArtifact) {
        producedArtifacts.push(outcome.record.outputArtifact);
      }
      if (outcome.approvalRequest) {
        await context.approvalManager.add(outcome.approvalRequest);
        context.approvals = context.approvalManager.snapshot();
        blockers.push(outcome.approvalRequest.reason);
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = outcome.approvalRequest.reason;
        }
        return { success: false, records, changedFiles, producedArtifacts, blockers };
      }
      if (outcome.record.status !== "success") {
        const error = outcome.record.error ?? `Tool '${toolName}' failed.`;
        blockers.push(error);
        const latestTrace = context.stepTrace.at(-1);
        if (latestTrace) {
          latestTrace.resultSummary = error;
        }
        return { success: false, records, changedFiles, producedArtifacts, blockers };
      }
      if (toolName === "fs.write") {
        const writeInput = toolInput as { path: string };
        changedFiles.push(resolveTarget(context.workingDirectory, writeInput.path));
      }
      const latestTrace = context.stepTrace.at(-1);
      const successSummary = `Tool '${toolName}' completed successfully.`;
      if (latestTrace) {
        latestTrace.resultSummary = successSummary;
      }
      observation = successSummary;
      continue;
    }

    blockers.push(`Executor exhausted action budget for step '${step.title}'.`);
    return { success: false, records, changedFiles, producedArtifacts, blockers };
  }

  private async chooseAction(
    step: PlanStep,
    analysis: AnalysisResult,
    context: AgentRuntimeContext,
    observation: string,
  ): Promise<ExecutorAction> {
    const prompt = buildExecutorPrompt(analysis, step, context.contextSnapshot, observation);
    const response = await context.llm.generateObject(
      {
        role: "executor",
        prompt,
        input: {
          analysis,
          step,
          observation,
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
    overrideInput?: ExecutorAction["toolInput"],
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
        const current = await readFile(absolute, "utf8");
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
}

function normalizeToolInputOverride(overrideInput?: ExecutorAction["toolInput"]): Record<string, unknown> {
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
