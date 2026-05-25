import type { ApprovalRequest, OutputFormat } from "../schemas.js";

export interface ApprovalWriter {
  writeLine(line: string): void;
}

export function renderApprovals(
  writer: ApprovalWriter,
  approvals: ApprovalRequest[],
  outputFormat: OutputFormat,
  options: {
    runId: string;
    decision?: {
      approvalId: string;
      status: "approved" | "denied";
    };
  },
): void {
  if (outputFormat === "json") {
    writer.writeLine(JSON.stringify(approvals, null, 2));
    return;
  }

  const lines: string[] = [];
  if (options.decision) {
    lines.push(
      `${options.decision.status === "approved" ? "Approved" : "Denied"} ${options.decision.approvalId}.`,
    );
    if (options.decision.status === "approved") {
      lines.push(`Use "little-helper resume ${options.runId}" to continue.`);
    }
  }

  if (approvals.length === 0) {
    lines.push(`No approvals recorded for run ${options.runId}.`);
    lines.forEach((line) => writer.writeLine(line));
    return;
  }

  lines.push(`Approvals for run ${options.runId}:`);
  approvals.forEach((approval) => {
    lines.push(
      `${approval.id}: ${capitalizeSentence(describeApprovalAction(approval.toolName))}. ${summarizeApprovalReason(approval.reason)} Status: ${approval.status}.`,
    );
  });

  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length > 0) {
    lines.push(
      `Approve with "little-helper approvals ${options.runId} --approve <approvalId> --resume" to continue immediately, or run "little-helper resume ${options.runId}" after approval.`,
    );
  }

  lines.forEach((line) => writer.writeLine(line));
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

function summarizeApprovalReason(reason: string): string {
  const normalized = reason.trim();
  if (/network access .* disabled by default/i.test(normalized)) {
    return "Network access needs approval.";
  }
  if (/network target .* not allowlisted/i.test(normalized)) {
    return "External network access needs approval.";
  }
  if (/approval required/i.test(normalized)) {
    return "This action needs approval.";
  }
  if (/suggest mode requires approval/i.test(normalized)) {
    return "Suggest mode needs approval before making changes.";
  }
  if (/auto-edit mode still requires approval/i.test(normalized)) {
    return "This command needs approval in auto-edit mode.";
  }
  return normalized;
}

function capitalizeSentence(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
