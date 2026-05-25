import type { RunResult } from "../harness/controller.js";
import type { OutputFormat } from "../schemas.js";

export interface RunResultWriter {
  writeLine(line: string): void;
}

export function renderRunResult(
  writer: RunResultWriter,
  result: Pick<RunResult, "state" | "execution" | "evaluation">,
  outputFormat: OutputFormat,
  options: {
    omitAssistantReply?: boolean;
  } = {},
): void {
  if (outputFormat === "json") {
    writer.writeLine(JSON.stringify(result, null, 2));
    return;
  }
  if (options.omitAssistantReply && typeof result.execution?.assistantResponse === "string") {
    return;
  }
  writer.writeLine(buildRunTextReply(result));
}

export function buildRunTextReply(result: Pick<RunResult, "state" | "execution" | "evaluation">): string {
  if (typeof result.execution?.assistantResponse === "string" && result.execution.assistantResponse.length > 0) {
    return result.execution.assistantResponse;
  }
  if (result.state.status === "awaiting_approval") {
    return buildApprovalReply(result);
  }
  if ((result.execution?.blockers.length ?? 0) > 0) {
    return result.execution?.blockers.join(" ") ?? "The run reported a blocker.";
  }
  if (result.evaluation?.status === "needs_revision") {
    return result.evaluation.requiredRevisions[0] ?? buildRunSummary(result);
  }
  return buildRunSummary(result);
}

function buildApprovalReply(result: Pick<RunResult, "state" | "execution">): string {
  const pendingToolCall = result.execution?.toolCalls
    .slice()
    .reverse()
    .find((record) => record.approvalProvenance === "pending" || record.status === "skipped");
  if (pendingToolCall?.toolName) {
    return [
      `Approval required to ${describeApprovalAction(pendingToolCall.toolName)}.`,
      `Run ${result.state.runId} is awaiting approval.`,
      `Use "little-helper approvals ${result.state.runId} --approve <approvalId> --resume" to continue immediately, or inspect approvals first with "little-helper approvals ${result.state.runId}".`,
    ].join(" ");
  }
  return [
    `Run ${result.state.runId} is awaiting approval.`,
    `Use "little-helper approvals ${result.state.runId} --approve <approvalId> --resume" to continue immediately, or inspect approvals first with "little-helper approvals ${result.state.runId}".`,
  ].join(" ");
}

function buildRunSummary(result: Pick<RunResult, "state" | "execution" | "evaluation">): string {
  const fragments = [
    `Run ${result.state.runId} finished with status ${result.state.status}.`,
    result.execution?.summary,
    result.evaluation?.status ? `Evaluation: ${result.evaluation.status}.` : undefined,
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return fragments.join(" ");
}

function describeApprovalAction(toolName: string): string {
  if (toolName === "web.search") {
    return "search the web";
  }
  if (toolName === "web.fetch") {
    return "access the web";
  }
  if (toolName === "fs.list") {
    return "inspect the workspace";
  }
  if (toolName === "fs.read") {
    return "read a file";
  }
  if (toolName === "fs.write" || toolName === "patch.apply") {
    return "edit files";
  }
  if (toolName === "shell.exec" || toolName === "validation.run") {
    return "run a command";
  }
  return `use ${toolName}`;
}
