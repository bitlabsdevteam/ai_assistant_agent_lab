import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  buildEvaluatorPromptEnvelope,
  buildPromptArtifactRecord,
  renderPromptEnvelopeForTransport,
} from "../llm/prompts.js";
import { EvaluationResultSchema, type AnalysisResult, type EvaluationResult, type ExecutionReport } from "../schemas.js";
import type { Agent, AgentRuntimeContext } from "./base.js";

export class EvaluatorAgent
  implements Agent<{ analysis: AnalysisResult; execution: ExecutionReport }, EvaluationResult>
{
  public readonly name = "evaluator";

  public async run(
    input: { analysis: AnalysisResult; execution: ExecutionReport },
    context: AgentRuntimeContext,
  ): Promise<EvaluationResult> {
    const prompt = buildEvaluatorPromptEnvelope(
      context.runRequest ?? {
        task: input.analysis.objective,
        workingDirectory: context.workingDirectory,
        profile: "default",
        dryRun: context.dryRun,
        maxIterations: context.budget.maxIterations,
        selectedSkills: [],
        metadata: {},
      },
      input.analysis,
      input.execution,
      context.contextSnapshot,
      {
        dryRun: context.dryRun,
        permissions: context.permissions,
        approvalMode: context.settings.approvalMode,
        ...(context.operatorMode ? { operatorMode: context.operatorMode } : {}),
      },
    );
    await context.artifactStore.writeJson(
      "prompt-envelope-evaluator.json",
      {
        envelope: prompt,
        transport: renderPromptEnvelopeForTransport(prompt, {
          analysis: input.analysis,
          execution: input.execution,
        }),
      },
      {
        confidentiality: "metadata_only",
        metadata: buildPromptArtifactRecord(prompt),
      },
    );

    const passedCriteria: string[] = [];
    const failedCriteria: string[] = [];
    const requiredRevisions: string[] = [];
    const validationCommands: string[] = [];
    const validationDecisions: EvaluationResult["validationDecisions"] = [];
    const productionReadinessNotes: string[] = [];

    for (const criterion of input.analysis.successCriteria) {
      const passed = await this.evaluateCriterion(criterion, input.analysis.objective, context);
      if (passed) {
        passedCriteria.push(criterion);
      } else {
        failedCriteria.push(criterion);
        requiredRevisions.push(`Unmet criterion: ${criterion}`);
      }
    }

    if (input.execution.blockers.length > 0) {
      failedCriteria.push(...input.execution.blockers);
      requiredRevisions.push(...input.execution.blockers);
    }

    const validationPlan = await this.resolveValidationPlan(input, context, failedCriteria.length === 0);
    productionReadinessNotes.push(...validationPlan.notes);
    validationDecisions.push(...validationPlan.skipped);

    for (const entry of validationPlan.commands) {
      const command = entry.command;
      const commandLabel = command.join(" ");
      validationCommands.push(commandLabel);
      const outcome = await context.tools.invoke(
        "validation.run",
        {
          command,
          timeoutMs: context.settings.commandTimeoutMs,
        },
        {
          runId: context.runId,
          workingDirectory: context.workingDirectory,
          dryRun: false,
          permissions: context.permissions,
          signal: context.signal,
          settings: context.settings,
          artifactStore: context.artifactStore,
          policy: context.policy,
          approvals: context.approvals,
        },
        context.artifactStore,
        context.policy,
      );
      context.budget.toolCallsUsed += 1;
      if (outcome.record.status !== "success") {
        validationDecisions.push({
          command,
          source: entry.source,
          status: "failed",
          reason: outcome.record.error ?? `Validation command failed: ${commandLabel}`,
        });
        productionReadinessNotes.push(`Validation command failed: ${commandLabel}`);
        failedCriteria.push(`Validation failed: ${commandLabel}`);
        requiredRevisions.push(`Fix validation failure: ${commandLabel}`);
        continue;
      }
      const result = outcome.result as { exitCode?: number; stderr?: string };
      validationDecisions.push({
        command,
        source: entry.source,
        status: (result.exitCode ?? 1) === 0 ? "passed" : "failed",
        reason: entry.reason,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(outcome.record.outputArtifact ? { outputArtifact: outcome.record.outputArtifact } : {}),
      });
      if ((result.exitCode ?? 1) !== 0) {
        productionReadinessNotes.push(`Validation command exited non-zero: ${commandLabel}`);
        failedCriteria.push(`Validation failed: ${commandLabel}`);
        requiredRevisions.push(`Resolve validation failure for: ${commandLabel}`);
      } else if (result.stderr && result.stderr.length > 0) {
        productionReadinessNotes.push(`Validation command produced stderr: ${commandLabel}`);
      }
    }

    if (validationCommands.length === 0 && validationDecisions.length === 0) {
      productionReadinessNotes.push("No validation commands configured or auto-detected.");
    }

    const result = EvaluationResultSchema.parse({
      status: failedCriteria.length === 0 ? "pass" : "needs_revision",
      passedCriteria,
      failedCriteria,
      requiredRevisions,
      validationCommands,
      validationDecisions,
      productionReadinessNotes,
    });
    context.budget.promptCharsUsed += renderPromptEnvelopeForTransport(prompt, {
      analysis: input.analysis,
      execution: input.execution,
    }).promptChars;
    return result;
  }

  private async evaluateCriterion(criterion: string, objective: string, context: AgentRuntimeContext): Promise<boolean> {
    const createFileMatch = objective.match(/create file\s+(.+?)\s+with content\s+([\s\S]+)/i);
    if (createFileMatch?.[1] && createFileMatch[2] && criterion.includes(createFileMatch[1].trim())) {
      const target = path.join(context.workingDirectory, createFileMatch[1].trim());
      try {
        await access(target, fsConstants.R_OK);
        const content = await readFile(target, "utf8");
        return content === createFileMatch[2];
      } catch {
        return false;
      }
    }

    if (criterion.toLowerCase().includes("workspace inspection completed")) {
      return true;
    }

    return context.stepTrace.length > 0;
  }

  private async resolveValidationPlan(
    input: { analysis: AnalysisResult; execution: ExecutionReport },
    context: AgentRuntimeContext,
    criteriaSatisfied: boolean,
  ): Promise<{
    commands: Array<{
      command: string[];
      source: "configured" | "auto";
      reason: string;
    }>;
    skipped: EvaluationResult["validationDecisions"];
    notes: string[];
  }> {
    if (context.settings.validationCommands.length > 0) {
      return {
        commands: context.settings.validationCommands.map((command) => ({
          command,
          source: "configured" as const,
          reason: "Configured in settings.",
        })),
        skipped: [],
        notes: [],
      };
    }

    const skipped: EvaluationResult["validationDecisions"] = [];
    const notes: string[] = [];
    if (this.shouldSkipAutoValidation(input, context, criteriaSatisfied)) {
      const reason = "No workspace mutation or validation-worthy action performed.";
      skipped.push({
        command: ["auto-validation"],
        source: "auto",
        status: "skipped",
        reason,
      });
      notes.push(reason);
      return {
        commands: [],
        skipped,
        notes,
      };
    }

    const packageJson = await this.readPackageJson(context.workingDirectory);
    if (!packageJson || !hasTestScript(packageJson)) {
      return {
        commands: [],
        skipped,
        notes,
      };
    }

    const manager = await detectNodePackageManager(context.workingDirectory, packageJson);
    const command = manager === "pnpm" ? ["pnpm", "test"] : ["npm", "test"];
    const executable = command[0];
    if (!executable) {
      return {
        commands: [],
        skipped,
        notes,
      };
    }
    if (!context.settings.shellAllowlist.includes(executable)) {
      skipped.push({
        command,
        source: "auto",
        status: "skipped",
        reason: `Auto-detected test command blocked by shell allowlist: ${executable}`,
      });
      notes.push(`Skipped auto-detected validation because '${executable}' is not allowlisted.`);
      return {
        commands: [],
        skipped,
        notes,
      };
    }

    return {
      commands: [
        {
          command,
          source: "auto",
          reason: "Auto-detected from package.json test script.",
        },
      ],
      skipped,
      notes,
    };
  }

  private shouldSkipAutoValidation(
    input: { analysis: AnalysisResult; execution: ExecutionReport },
    context: AgentRuntimeContext,
    criteriaSatisfied: boolean,
  ): boolean {
    if (!criteriaSatisfied) {
      return false;
    }
    if (input.execution.changedFiles.length > 0) {
      return false;
    }
    if (input.execution.blockers.length > 0) {
      return false;
    }
    if (input.execution.needsEvaluation) {
      return false;
    }
    if (hasSideEffectingToolCall(input.execution)) {
      return false;
    }
    return context.stepTrace.at(-1)?.chosenActionType === "final_response";
  }

  private async readPackageJson(workingDirectory: string): Promise<NodePackageJson | undefined> {
    const target = path.join(workingDirectory, "package.json");
    try {
      await access(target, fsConstants.R_OK);
      const raw = await readFile(target, "utf8");
      return NodePackageJsonSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
}

const NodePackageJsonSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

interface NodePackageJson {
  packageManager?: string | undefined;
  scripts?: Record<string, string> | undefined;
}

function hasTestScript(packageJson: NodePackageJson): boolean {
  const testScript = packageJson.scripts?.test;
  return typeof testScript === "string" && testScript.trim().length > 0;
}

async function detectNodePackageManager(
  workingDirectory: string,
  packageJson: NodePackageJson,
): Promise<"npm" | "pnpm"> {
  const packageManager = packageJson.packageManager?.toLowerCase() ?? "";
  if (packageManager.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (await pathExists(path.join(workingDirectory, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  return "npm";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hasSideEffectingToolCall(execution: ExecutionReport): boolean {
  return execution.toolCalls.some((record) => {
    if (record.status !== "success") {
      return false;
    }
    if (record.category === undefined) {
      return true;
    }
    return (
      record.category === "edit" ||
      record.category === "execution" ||
      record.category === "network" ||
      record.category === "validation" ||
      record.category === "mcp"
    );
  });
}
