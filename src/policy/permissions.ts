import path from "node:path";

import { AppError } from "../errors.js";
import type { ApprovalRequest, ApprovalMode, PermissionScope, RiskLevel, Settings, ToolDescriptor } from "../schemas.js";
import { classifyCommandRisk } from "./safety.js";

export interface PolicyDecision {
  outcome: "allow" | "deny" | "require_approval";
  reason: string;
  riskLevel: RiskLevel;
}

export class PermissionPolicy {
  public constructor(public readonly settings: Settings) {}

  public ensurePathAllowed(targetPath: string): void {
    const resolved = path.resolve(targetPath);
    const allowed = this.settings.allowedRoots.some((root) => {
      const normalizedRoot = path.resolve(root);
      return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`);
    });

    if (!allowed) {
      throw new AppError("POLICY_ERROR", `Path is outside allowed roots: ${targetPath}`);
    }
  }

  public decideTool(
    tool: ToolDescriptor,
    input: unknown,
    approvalMode: ApprovalMode = this.settings.approvalMode,
    approvals: ApprovalRequest[] = [],
  ): PolicyDecision {
    const riskLevel = inferRiskLevel(tool, input);
    const requiresApproval = tool.requiresApproval || tool.sideEffecting;
    const inputDigest = createApprovalInputDigest(input);
    const approvedMatch = approvals.find(
      (approval) =>
        approval.status === "approved" && approval.toolName === tool.name && approval.inputDigest === inputDigest,
    );
    if (approvedMatch) {
      return {
        outcome: "allow",
        reason: "Action allowed by recorded approval.",
        riskLevel,
      };
    }
    const deniedMatch = approvals.find(
      (approval) =>
        approval.status === "denied" && approval.toolName === tool.name && approval.inputDigest === inputDigest,
    );
    if (deniedMatch) {
      return {
        outcome: "deny",
        reason: "Action was explicitly denied by approval workflow.",
        riskLevel,
      };
    }

    if (approvalMode === "never" && (riskLevel === "high" || requiresApproval)) {
      return {
        outcome: "deny",
        reason: "Approval mode forbids this action.",
        riskLevel,
      };
    }

    if (approvalMode === "always" && requiresApproval) {
      return {
        outcome: "require_approval",
        reason: "Approval mode requires confirmation for side effects.",
        riskLevel,
      };
    }

    if (approvalMode === "on-risk" && riskLevel === "high") {
      return {
        outcome: "require_approval",
        reason: "High-risk action requires approval.",
        riskLevel,
      };
    }

    return {
      outcome: "allow",
      reason: "Action allowed by policy.",
      riskLevel,
    };
  }

  public ensureShellAllowed(command: string[]): void {
    const executable = command[0];
    if (!executable) {
      throw new AppError("VALIDATION_ERROR", "Shell command requires at least one argument.");
    }
    if (!this.settings.shellAllowlist.includes(executable)) {
      throw new AppError("POLICY_ERROR", `Command is not allowlisted: ${executable}`);
    }
  }

  public ensurePermissionScope(scope: PermissionScope, grantedScopes: PermissionScope[]): void {
    if (!grantedScopes.includes(scope)) {
      throw new AppError("POLICY_ERROR", `Permission scope missing: ${scope}`);
    }
  }

  public ensureNetworkAllowed(urlString: string): void {
    const url = new URL(urlString);
    if (this.settings.networkAllowlist.length === 0) {
      throw new AppError("POLICY_ERROR", "Network access is disabled.");
    }
    if (!this.settings.networkAllowlist.includes(url.hostname)) {
      throw new AppError("POLICY_ERROR", `Network target is not allowlisted: ${url.hostname}`);
    }
  }
}

function inferRiskLevel(tool: ToolDescriptor, input: unknown): RiskLevel {
  if (tool.name === "shell.exec" || tool.name === "validation.run") {
    const parsed = input as { command?: string[] };
    if (parsed.command) {
      return classifyCommandRisk(parsed.command);
    }
  }
  return tool.riskLevel;
}

export function buildApprovalRequest(
  runId: string,
  tool: ToolDescriptor,
  actionSummary: string,
  input: unknown,
  reason: string,
  riskLevel: RiskLevel,
  options?: {
    stepId?: string;
    target?: string;
  },
): ApprovalRequest {
  return {
    id: `${runId}-${tool.name}-${Date.now()}`,
    runId,
    createdAt: new Date().toISOString(),
    status: "pending",
    ...(options?.stepId ? { stepId: options.stepId } : {}),
    toolName: tool.name,
    reason,
    riskLevel,
    actionSummary,
    inputDigest: createApprovalInputDigest(input),
    ...(options?.target ? { target: options.target } : {}),
  };
}

export function createApprovalInputDigest(input: unknown): string {
  return JSON.stringify(input);
}
