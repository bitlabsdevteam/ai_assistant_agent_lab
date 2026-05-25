import path from "node:path";

import { AppError } from "../errors.js";
import type {
  ApprovalRequest,
  ApprovalMode,
  OperatorMode,
  PermissionScope,
  RiskLevel,
  Settings,
  ToolDescriptor,
} from "../schemas.js";
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
    operatorMode: OperatorMode = "full-auto",
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

    const networkDecision = this.decideNetworkAccess(tool, input, approvalMode, approvals);
    if (networkDecision) {
      return networkDecision;
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

    if (operatorMode === "suggest" && (tool.category === "edit" || tool.name === "shell.exec")) {
      return {
        outcome: "require_approval",
        reason: "Suggest mode requires approval for edits and shell commands.",
        riskLevel,
      };
    }

    if (operatorMode === "auto-edit" && tool.name === "shell.exec") {
      return {
        outcome: "require_approval",
        reason: "Auto-edit mode still requires approval for shell commands.",
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

  public ensureNetworkAllowed(
    urlString: string,
    options?: {
      toolName?: string;
      input?: unknown;
      approvals?: ApprovalRequest[];
    },
  ): void {
    const url = new URL(urlString);
    if (this.settings.networkAllowlist.includes(url.hostname)) {
      return;
    }
    if (options?.toolName && this.hasApprovedNetworkAccess(options.toolName, options.input, options.approvals)) {
      return;
    }
    throw new AppError(
      "POLICY_ERROR",
      this.settings.networkAllowlist.length === 0
        ? "Network access is disabled."
        : `Network target is not allowlisted: ${url.hostname}`,
    );
  }

  private decideNetworkAccess(
    tool: ToolDescriptor,
    input: unknown,
    approvalMode: ApprovalMode,
    approvals: ApprovalRequest[],
  ): PolicyDecision | undefined {
    const target = getNetworkTarget(tool.name, input);
    if (!target) {
      return undefined;
    }
    const url = new URL(target);
    if (this.settings.networkAllowlist.includes(url.hostname)) {
      return undefined;
    }
    if (this.hasApprovedNetworkAccess(tool.name, input, approvals)) {
      return {
        outcome: "allow",
        reason: `Network target '${url.hostname}' allowed by recorded approval.`,
        riskLevel: "high",
      };
    }
    if (approvalMode === "never") {
      return {
        outcome: "deny",
        reason: this.settings.networkAllowlist.length === 0
          ? "Approval mode forbids network access because network access is disabled."
          : `Approval mode forbids network access to non-allowlisted host '${url.hostname}'.`,
        riskLevel: "high",
      };
    }
    return {
      outcome: "require_approval",
      reason: this.settings.networkAllowlist.length === 0
        ? `Network access to '${url.hostname}' requires approval because network access is disabled by default.`
        : `Network target '${url.hostname}' requires approval because it is not allowlisted.`,
      riskLevel: "high",
    };
  }

  private hasApprovedNetworkAccess(toolName: string, input: unknown, approvals: ApprovalRequest[] = []): boolean {
    const digest = createApprovalInputDigest(input);
    const target = getNetworkTarget(toolName, input);
    return approvals.some((approval) => {
      if (approval.status !== "approved" || approval.toolName !== toolName) {
        return false;
      }
      if (approval.inputDigest === digest) {
        return true;
      }
      if (!target) {
        return false;
      }
      if (approval.input !== undefined) {
        return getNetworkTarget(toolName, approval.input) === target;
      }
      return toolName === "web.search";
    });
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
    input,
    ...(options?.target ? { target: options.target } : {}),
  };
}

export function createApprovalInputDigest(input: unknown): string {
  return stableSerialize(input);
}

function getNetworkTarget(toolName: string, input: unknown): string | undefined {
  if (toolName === "web.search") {
    return "https://api.perplexity.ai/search";
  }
  if (toolName === "web.fetch") {
    const parsed = input as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : undefined;
  }
  return undefined;
}

function stableSerialize(input: unknown): string {
  return JSON.stringify(normalizeForDigest(input));
}

function normalizeForDigest(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((entry) => normalizeForDigest(entry));
  }
  if (!input || typeof input !== "object") {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizeForDigest(value)]),
  );
}
