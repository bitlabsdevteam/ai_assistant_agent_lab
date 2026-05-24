import type { AnalysisResult, ExecutionReport, PlanStep, RunRequest } from "../schemas.js";
import type { AgentContextSnapshot } from "../schemas.js";

export function buildAnalyzerPrompt(request: RunRequest, contextSnapshot?: AgentContextSnapshot): string {
  return `Analyze the following task and return structured JSON: ${request.task}\n\nContext:\n${
    contextSnapshot?.summary ?? "No prior context."
  }`;
}

export function buildExecutorPrompt(
  analysis: AnalysisResult,
  step: PlanStep,
  contextSnapshot?: AgentContextSnapshot,
  observation?: string,
): string {
  return [
    "Execute the current plan step using one explicit typed action.",
    `Objective: ${analysis.objective}`,
    `Current step: ${step.id} - ${step.title}`,
    `Step description: ${step.description}`,
    `Allowed tools for this step: ${step.toolNames.join(", ") || "none"}`,
    `Expected output: ${step.expectedOutput}`,
    `Current observation: ${observation ?? `Starting step '${step.title}'.`}`,
    "Choose exactly one action: tool_call, final_response, or clarification.",
    "If you choose tool_call, use one of the allowed tools and provide concrete toolInput when you know it.",
    `Context:\n${contextSnapshot?.summary ?? "No prior context."}`,
  ].join("\n\n");
}

export function buildEvaluatorPrompt(
  analysis: AnalysisResult,
  execution: ExecutionReport,
  contextSnapshot?: AgentContextSnapshot,
): string {
  return `Evaluate whether execution satisfies the success criteria. Criteria: ${analysis.successCriteria.join(
    "; ",
  )}. Execution summary: ${execution.summary}\n\nContext:\n${contextSnapshot?.summary ?? "No prior context."}`;
}
