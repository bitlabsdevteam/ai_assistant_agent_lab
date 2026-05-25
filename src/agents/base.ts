import type { Logger } from "pino";

import type { ArtifactStore } from "../memory/artifact-store.js";
import type { PermissionPolicy } from "../policy/permissions.js";
import type { ApprovalManager } from "../harness/approvals.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { LLMClient, LLMStreamEvent } from "../llm/client.js";
import type {
  AgentContextSnapshot,
  AgentStepState,
  ApprovalRequest,
  OperatorMode,
  PermissionScope,
  RunBudgetState,
  RunRequest,
  Settings,
  TelemetryEvent,
} from "../schemas.js";

export interface AgentRuntimeContext {
  runId: string;
  workingDirectory: string;
  settings: Settings;
  permissions: PermissionScope[];
  dryRun: boolean;
  llm: LLMClient;
  tools: ToolRegistry;
  policy: PermissionPolicy;
  approvalManager: ApprovalManager;
  approvals: ApprovalRequest[];
  operatorMode?: OperatorMode;
  artifactStore: ArtifactStore;
  logger: Logger;
  budget: RunBudgetState;
  stepTrace: AgentStepState[];
  runRequest?: RunRequest;
  contextSnapshot?: AgentContextSnapshot;
  onLLMEvent?: (event: LLMStreamEvent) => void | Promise<void>;
  onTelemetryEvent?: (event: TelemetryEvent) => void | Promise<void>;
  signal: AbortSignal;
}

export interface Agent<TInput, TOutput> {
  readonly name: string;
  run(input: TInput, context: AgentRuntimeContext): Promise<TOutput>;
}
