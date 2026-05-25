import type { z } from "zod";

import type { PermissionPolicy } from "../policy/permissions.js";
import type { ArtifactStore } from "../memory/artifact-store.js";
import type {
  ApprovalRequest,
  OperatorMode,
  PermissionScope,
  Settings,
  TerminalSessionState,
  TelemetryEvent,
  ToolCategory,
  ToolDescriptor,
} from "../schemas.js";

type AnySchema = z.ZodType<unknown, z.ZodTypeDef, unknown>;

export interface ToolContext {
  runId: string;
  workingDirectory: string;
  dryRun: boolean;
  permissions: PermissionScope[];
  signal: AbortSignal;
  settings: Settings;
  artifactStore: ArtifactStore;
  policy: PermissionPolicy;
  approvals: ApprovalRequest[];
  operatorMode?: OperatorMode;
  onTelemetryEvent?: (event: TelemetryEvent) => void | Promise<void>;
}

export interface Tool<TInput extends AnySchema, TOutput extends AnySchema> {
  readonly descriptor: ToolDescriptor;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  validate(input: z.infer<TInput>, context: ToolContext): Promise<void> | void;
  run(input: z.infer<TInput>, context: ToolContext): Promise<z.infer<TOutput>>;
}

export interface RegisteredTool {
  descriptor: ToolDescriptor;
  invoke(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface SessionController {
  start(command: string[], context: ToolContext): Promise<TerminalSessionState>;
  poll(sessionId: string): Promise<TerminalSessionState | undefined>;
  stop(sessionId: string): Promise<TerminalSessionState | undefined>;
}

export function buildDescriptor(input: {
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: "low" | "medium" | "high";
  sideEffecting: boolean;
  requiresApproval?: boolean;
  dryRunSafe?: boolean;
  permissionScope: PermissionScope;
}): ToolDescriptor {
  return {
    requiresApproval: false,
    dryRunSafe: true,
    ...input,
  };
}
