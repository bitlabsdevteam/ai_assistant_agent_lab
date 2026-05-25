import type { AnalysisResult, ExecutionReport, ExecutorStepMemory, PlanStep, RunRequest } from "../schemas.js";
import type { AgentContextSnapshot } from "../schemas.js";

export function buildAnalyzerPrompt(
  request: RunRequest,
  availableTools: Array<{ name: string; description: string; sideEffecting: boolean; category: string }>,
  contextSnapshot?: AgentContextSnapshot,
): string {
  const chatContext = request.conversationContext
    ? [
        `Chat session: ${request.conversationContext.sessionId}`,
        `Latest user message: ${request.conversationContext.latestUserMessage}`,
        `Conversation summary: ${request.conversationContext.conversationSummary || "none"}`,
        `Last assistant summary: ${request.conversationContext.lastAssistantSummary ?? "none"}`,
      ].join("\n")
    : "No chat context.";
  const toolCatalog =
    availableTools.length > 0
      ? availableTools
          .map((tool) => `${tool.name} [${tool.category}${tool.sideEffecting ? ", side-effecting" : ""}]: ${tool.description}`)
          .join("\n")
      : "No tools registered.";
  return [
    `Analyze the following task and return structured JSON: ${request.task}`,
    "Plan only with registered tool names from the catalog below. Never invent tools.",
    "For simple conversation, greetings, thanks, or lightweight Q&A that does not need tools, create a direct response step with no tools.",
    "For current events, weather, or recent web information, prefer web.search when it is available.",
    `Chat:\n${chatContext}`,
    `Tool catalog:\n${toolCatalog}`,
    `Context:\n${contextSnapshot?.summary ?? "No prior context."}`,
  ].join("\n\n");
}

export function buildExecutorPrompt(
  analysis: AnalysisResult,
  step: PlanStep,
  contextSnapshot?: AgentContextSnapshot,
  observation?: string,
  stepMemory?: ExecutorStepMemory,
): string {
  return [
    "Execute the current plan step using one explicit typed action.",
    `Objective: ${analysis.objective}`,
    `Current step: ${step.id} - ${step.title}`,
    `Step description: ${step.description}`,
    `Allowed tools for this step: ${step.toolNames.join(", ") || "none"}`,
    `Expected output: ${step.expectedOutput}`,
    `Current observation: ${observation ?? `Starting step '${step.title}'.`}`,
    `Step memory: ${stepMemory ? JSON.stringify(stepMemory) : "none"}`,
    "Choose exactly one action: tool_call, patch_proposal, final_response, clarification, or handoff_to_evaluator.",
    "Never expose hidden planning, analyzer output, evaluator output, or JSON to the end user.",
    "When you choose final_response, write the exact assistant message that should be shown to the user.",
    "If no tools are allowed for the step, choose final_response or clarification instead of inventing a tool.",
    "Prefer patch_proposal over direct write tools when a file edit is needed.",
    "If you choose tool_call, use one of the allowed tools and provide concrete toolInput as an array of { key, value } entries when you know it.",
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
