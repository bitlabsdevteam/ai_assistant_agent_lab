import { randomUUID } from "node:crypto";

import type { RunResult } from "../harness/controller.js";
import { ApprovalManager } from "../harness/approvals.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import type {
  ApprovalRequest,
  HarnessStatus,
  HeadlessApprovalRecord,
  HeadlessApprovalState,
  HeadlessRunResponse,
  HeadlessRunStatus,
  HeadlessRunRecord,
} from "../schemas.js";

export function createPublicId(): string {
  return randomUUID();
}

export function mapHarnessStatusToRunStatus(status: HarnessStatus): HeadlessRunStatus {
  switch (status) {
    case "awaiting_approval":
      return "awaiting_approval";
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
    case "cancelled":
    case "paused":
      return "failed";
    case "created":
    case "planning":
    case "executing":
    case "evaluating":
    case "revising":
      return "running";
  }
}

export function buildAssistantReply(
  result: Pick<RunResult, "state" | "analysis" | "execution" | "evaluation">,
  pendingApprovals: Array<Pick<HeadlessApprovalRecord, "toolName" | "reason">> = [],
): string {
  if (result.execution?.assistantResponse) {
    return result.execution.assistantResponse;
  }
  if (result.state.status === "awaiting_approval") {
    const first = pendingApprovals[0];
    if (first) {
      return `I need approval to ${describeApprovalAction(first.toolName)} before I can continue. ${summarizeApprovalReason(first.reason)}`;
    }
    return "I need approval before I can continue with the requested action.";
  }
  if ((result.execution?.blockers.length ?? 0) > 0) {
    return result.execution?.blockers.join(" ") ?? "The run reported a blocker.";
  }
  if (result.evaluation?.status === "needs_revision") {
    return result.evaluation.requiredRevisions[0] ?? buildAssistantSummary(result.state.status, result.state.runId, result);
  }
  return buildAssistantSummary(result.state.status, result.state.runId, result);
}

export function buildAssistantSummary(
  status: HarnessStatus,
  runId: string,
  result: Pick<RunResult, "execution" | "evaluation">,
): string {
  const fragments = [
    `Run ${runId} finished with status ${status}.`,
    result.execution?.summary,
    result.evaluation?.status ? `Evaluation: ${result.evaluation.status}.` : undefined,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return fragments.join(" ");
}

export function splitAssistantText(reply: string): string[] {
  return reply.match(/\S+\s*/g) ?? [reply];
}

export function approvalStateFromApprovals(approvals: HeadlessApprovalRecord[]): HeadlessApprovalState {
  if (approvals.some((approval) => approval.status === "pending")) {
    return "pending";
  }
  if (approvals.some((approval) => approval.status === "denied")) {
    return "denied";
  }
  if (approvals.some((approval) => approval.status === "approved")) {
    return "approved";
  }
  return "none";
}

export async function loadRunApprovals(artifactDir: string, runId: string): Promise<ApprovalRequest[]> {
  const manager = new ApprovalManager(new ArtifactStore(artifactDir, runId));
  return manager.load();
}

export function toPublicRunResponse(run: HeadlessRunRecord): HeadlessRunResponse {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    ...(run.summary ? { summary: run.summary } : {}),
    ...(run.evaluationStatus ? { evaluationStatus: run.evaluationStatus } : {}),
    approvalState: run.approvalState,
    ...(run.assistantReply ? { assistantReply: run.assistantReply } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function describeApprovalAction(toolName: string): string {
  if (toolName === "web.search") {
    return "search the web";
  }
  if (toolName.startsWith("fs.")) {
    return "modify the workspace";
  }
  return `run ${toolName}`;
}

function summarizeApprovalReason(reason: string): string {
  return reason.endsWith(".") ? reason : `${reason}.`;
}
