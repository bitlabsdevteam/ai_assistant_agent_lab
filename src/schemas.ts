import { z } from "zod";

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export const ApprovalModeSchema = z.enum(["never", "on-risk", "always"]);
export const OutputFormatSchema = z.enum(["text", "json"]);
export const OperatorModeSchema = z.enum(["suggest", "auto-edit", "full-auto"]);
export const PermissionScopeSchema = z.enum([
  "read-only",
  "workspace",
  "network",
  "shell",
  "privileged",
]);
export const ToolCategorySchema = z.enum([
  "read",
  "edit",
  "execution",
  "search",
  "network",
  "mcp",
  "validation",
]);

export const ChatTurnRoleSchema = z.enum(["user", "assistant", "system"]);
export const ChatSessionStatusSchema = z.enum(["idle", "running", "awaiting_approval", "blocked"]);

export const RunRequestSchema = z.object({
  task: z.string().min(1),
  workingDirectory: z.string().min(1),
  profile: z.string().default("default"),
  dryRun: z.boolean().default(false),
  maxIterations: z.number().int().positive().default(3),
  metadata: z
    .object({
      sessionId: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
      sessionMode: OperatorModeSchema.optional(),
      selectedModel: z.string().min(1).optional(),
    })
    .catchall(z.string())
    .default({}),
  conversationContext: z
    .object({
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      latestUserMessage: z.string().min(1),
      conversationSummary: z.string().default(""),
      lastAssistantSummary: z.string().optional(),
      recentTurns: z
        .array(
          z.object({
            turnId: z.string().min(1),
            role: ChatTurnRoleSchema,
            content: z.string().min(1),
            timestamp: z.string(),
            runId: z.string().min(1).optional(),
            artifactRefs: z.array(z.string()).default([]),
            summary: z.string().optional(),
          }),
        )
        .default([]),
      includedArtifactRefs: z.array(z.string()).default([]),
    })
    .optional(),
});

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  agent: z.literal("executor"),
  toolNames: z.array(z.string()),
  expectedOutput: z.string().min(1),
  approvalRequired: z.boolean().default(false),
});

export const AnalysisResultSchema = z.object({
  objective: z.string().min(1),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
  successCriteria: z.array(z.string()),
  plan: z.array(PlanStepSchema),
  requiredTools: z.array(z.string()),
  riskLevel: RiskLevelSchema,
});

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  category: ToolCategorySchema.optional(),
  stepId: z.string().optional(),
  inputSummary: z.string(),
  status: z.enum(["success", "failed", "denied", "skipped"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  cwd: z.string().optional(),
  command: z.string().optional(),
  stdoutSummary: z.string().optional(),
  stderrSummary: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  approvalProvenance: z.enum(["none", "policy_allowed", "pending", "approved", "denied"]).optional(),
  outputArtifact: z.string().optional(),
  diffArtifact: z.string().optional(),
  transcriptArtifact: z.string().optional(),
  error: z.string().optional(),
});

export const ExecutionReportSchema = z.object({
  completedSteps: z.array(z.string()),
  skippedSteps: z.array(z.string()),
  toolCalls: z.array(ToolCallRecordSchema),
  changedFiles: z.array(z.string()),
  producedArtifacts: z.array(z.string()),
  blockers: z.array(z.string()),
  needsEvaluation: z.boolean().default(false),
  assistantResponse: z.string().optional(),
  summary: z.string(),
});

export const EvaluationResultSchema = z.object({
  status: z.enum(["pass", "fail", "needs_revision"]),
  passedCriteria: z.array(z.string()),
  failedCriteria: z.array(z.string()),
  requiredRevisions: z.array(z.string()),
  validationCommands: z.array(z.string()),
  validationDecisions: z.array(
    z.object({
      command: z.array(z.string()).min(1),
      source: z.enum(["configured", "auto"]),
      status: z.enum(["passed", "failed", "skipped"]),
      reason: z.string(),
      exitCode: z.number().int().optional(),
      outputArtifact: z.string().optional(),
    }),
  ),
  productionReadinessNotes: z.array(z.string()),
});

export const RevisionRecordSchema = z.object({
  iteration: z.number().int().nonnegative(),
  createdAt: z.string(),
  evaluationStatus: z.enum(["pass", "fail", "needs_revision"]),
  failedCriteria: z.array(z.string()),
  requiredRevisions: z.array(z.string()),
  validationCommands: z.array(z.string()),
  notes: z.array(z.string()),
});

export const MCPServerConfigSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
    url: z.string().url().optional(),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(30_000),
    allowedTools: z.array(z.string()).default([]),
  })
  .refine((value) => value.command !== undefined || value.url !== undefined, {
    message: "MCP server requires either command or url",
    path: ["command"],
  });

export const MCPToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  riskLevel: RiskLevelSchema.default("low"),
  sideEffecting: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  permissionScope: PermissionScopeSchema.default("read-only"),
  inputSchema: z.unknown().optional(),
});

export const MCPResourceDefinitionSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});

export const MCPResourceTemplateSchema = z.object({
  uriTemplate: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});

export const MCPDiscoverySchema = z.object({
  server: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  status: z.enum(["ready", "failed"]),
  tools: z.array(MCPToolDefinitionSchema),
  resources: z.array(MCPResourceDefinitionSchema).default([]),
  resourceTemplates: z.array(MCPResourceTemplateSchema).default([]),
  error: z.string().optional(),
});

export const MCPToolResultSchema = z.object({
  server: z.string(),
  tool: z.string(),
  result: z.unknown(),
});

export const AgentStepStateSchema = z.object({
  stepId: z.string(),
  observation: z.string(),
  chosenActionType: z.enum(["tool_call", "patch_proposal", "final_response", "clarification", "handoff_to_evaluator"]),
  chosenActionName: z.string(),
  rationaleSummary: z.string(),
  resultSummary: z.string().optional(),
});

const ToolInputScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ToolInputArraySchema = z.array(ToolInputScalarSchema);
const ToolInputValueSchema: z.ZodType<string | number | boolean | null | Array<string | number | boolean | null>> =
  z.union([ToolInputScalarSchema, ToolInputArraySchema]);
const ToolInputEntrySchema = z.object({
  key: z.string().min(1),
  value: ToolInputValueSchema,
});

export const PatchProposalSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  updatedContent: z.string(),
  createIfMissing: z.boolean().default(false),
});

export const ExecutorActionSchema = z.discriminatedUnion("actionType", [
  z.object({
    stepId: z.string().min(1),
    observation: z.string().min(1),
    actionType: z.literal("tool_call"),
    toolName: z.string().min(1),
    toolInput: z.array(ToolInputEntrySchema).default([]),
    rationaleSummary: z.string().min(1),
  }),
  z.object({
    stepId: z.string().min(1),
    observation: z.string().min(1),
    actionType: z.literal("patch_proposal"),
    patch: PatchProposalSchema,
    rationaleSummary: z.string().min(1),
  }),
  z.object({
    stepId: z.string().min(1),
    observation: z.string().min(1),
    actionType: z.literal("final_response"),
    rationaleSummary: z.string().min(1),
    finalResponse: z.string().min(1),
  }),
  z.object({
    stepId: z.string().min(1),
    observation: z.string().min(1),
    actionType: z.literal("clarification"),
    rationaleSummary: z.string().min(1),
    clarificationQuestion: z.string().min(1),
  }),
  z.object({
    stepId: z.string().min(1),
    observation: z.string().min(1),
    actionType: z.literal("handoff_to_evaluator"),
    rationaleSummary: z.string().min(1),
    handoffReason: z.string().min(1),
  }),
]);

export const TerminalSessionStateSchema = z.object({
  sessionId: z.string(),
  command: z.array(z.string()),
  mode: z.enum(["non_interactive", "pty"]),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled", "timed_out"]),
  exitCode: z.number().int().optional(),
  pid: z.number().int().positive().optional(),
  endedAt: z.string().optional(),
  terminationReason: z
    .enum(["completed", "failed", "timed_out", "operator_cancelled", "stale_on_recovery", "process_missing"])
    .optional(),
});

export const ChatTurnRecordSchema = z.object({
  turnId: z.string().min(1),
  role: ChatTurnRoleSchema,
  content: z.string().min(1),
  timestamp: z.string(),
  runId: z.string().min(1).optional(),
  artifactRefs: z.array(z.string()).default([]),
  summary: z.string().optional(),
});

export const ChatSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  workingDirectory: z.string().min(1),
  status: ChatSessionStatusSchema,
  activeRunId: z.string().min(1).optional(),
  turns: z.number().int().nonnegative(),
  conversationSummary: z.string().default(""),
  pendingApprovalIds: z.array(z.string()).default([]),
  lastRunStatus: z.lazy(() => HarnessStatusSchema).optional(),
});

export const InteractiveSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  updatedAt: z.string(),
  mode: OperatorModeSchema.default("suggest"),
  selectedModel: z.string().min(1).optional(),
  activeRunId: z.string().min(1).optional(),
  pendingPatchArtifact: z.string().min(1).optional(),
  recentActivitySummary: z.string().default(""),
});

export const ExecutorStepMemorySchema = z.object({
  stepId: z.string().min(1),
  objective: z.string().min(1),
  filesInspected: z.array(z.string()).default([]),
  proposedDiffArtifacts: z.array(z.string()).default([]),
  appliedDiffArtifacts: z.array(z.string()).default([]),
  commandOutputs: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  remainingSuccessCriteria: z.array(z.string()).default([]),
});

export const RunBudgetStateSchema = z.object({
  maxIterations: z.number().int().positive(),
  maxToolCalls: z.number().int().positive().optional(),
  maxPromptChars: z.number().int().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
  toolCallsUsed: z.number().int().nonnegative().default(0),
  promptCharsUsed: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative().default(0),
});

export const HarnessStatusSchema = z.enum([
  "created",
  "planning",
  "awaiting_approval",
  "executing",
  "evaluating",
  "revising",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

export const ApprovalStatusSchema = z.enum(["pending", "approved", "denied", "expired"]);

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  createdAt: z.string(),
  status: ApprovalStatusSchema,
  stepId: z.string().optional(),
  toolName: z.string(),
  reason: z.string(),
  riskLevel: RiskLevelSchema,
  actionSummary: z.string(),
  inputDigest: z.string(),
  input: z.unknown().optional(),
  decisionAt: z.string().optional(),
  target: z.string().optional(),
});

export const HarnessRunStateSchema = z.object({
  runId: z.string(),
  status: HarnessStatusSchema,
  phase: z.string(),
  iteration: z.number().int().nonnegative(),
  checkpointId: z.string().optional(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  lastHeartbeatAt: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  artifactDirectory: z.string(),
  requestArtifact: z.string().optional(),
  analysisArtifact: z.string().optional(),
  executionArtifact: z.string().optional(),
  evaluationArtifact: z.string().optional(),
  finalReportArtifact: z.string().optional(),
});

export const CheckpointRecordSchema = z.object({
  checkpointId: z.string(),
  runId: z.string(),
  createdAt: z.string(),
  status: z.string(),
  phase: z.string(),
  iteration: z.number().int().nonnegative(),
  latestAnalysisArtifact: z.string().optional(),
  latestExecutionArtifact: z.string().optional(),
  latestEvaluationArtifact: z.string().optional(),
  budgetArtifact: z.string().optional(),
  sessionsArtifact: z.string().optional(),
  approvalsArtifact: z.string().optional(),
});

export const TelemetryEventSchema = z.object({
  timestamp: z.string(),
  runId: z.string(),
  event: z.string(),
  status: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
  agent: z.string().optional(),
  toolName: z.string().optional(),
  errorCode: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const MetricRecordSchema = z.object({
  name: z.string(),
  value: z.number(),
  timestamp: z.string(),
  runId: z.string().optional(),
});

export const ContextSourceSchema = z.object({
  kind: z.enum([
    "instruction",
    "user_task",
    "chat_session",
    "run_state",
    "analysis",
    "execution",
    "evaluation",
    "revision",
    "approval",
    "tool_output",
    "step_trace",
    "mcp_resource",
  ]),
  label: z.string(),
  artifact: z.string().optional(),
});

export const AgentContextSnapshotSchema = z.object({
  agent: z.enum(["analyzer", "executor", "evaluator"]),
  summary: z.string(),
  promptChars: z.number().int().nonnegative(),
  compacted: z.boolean(),
  sources: z.array(ContextSourceSchema),
});

export const ChatEventTypeSchema = z.enum([
  "chat.session_started",
  "chat.turn_started",
  "chat.turn_completed",
  "chat.command_invoked",
]);

export const ChatEventSchema = z.object({
  type: ChatEventTypeSchema,
  timestamp: z.string(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
});

export const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: ToolCategorySchema,
  riskLevel: RiskLevelSchema,
  sideEffecting: z.boolean(),
  requiresApproval: z.boolean().default(false),
  dryRunSafe: z.boolean().default(true),
  permissionScope: PermissionScopeSchema,
});

export const LLMRoleOverrideSchema = z.object({
  provider: z.literal("openai").optional(),
  model: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  organization: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
});

export const SettingsSchema = z.object({
  env: z.enum(["development", "test", "production"]).default("development"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  artifactDir: z.string().min(1).default(".little-helper/runs"),
  llmProvider: z.literal("openai").default("openai"),
  llmModel: z.string().min(1).default("gpt-5.4"),
  llmBaseUrl: z.string().url().optional(),
  llmOrganization: z.string().min(1).optional(),
  llmProject: z.string().min(1).optional(),
  llmRouting: z
    .object({
      analyzer: LLMRoleOverrideSchema.optional(),
      executor: LLMRoleOverrideSchema.optional(),
      evaluator: LLMRoleOverrideSchema.optional(),
    })
    .default({}),
  maxIterations: z.number().int().positive().default(3),
  approvalMode: ApprovalModeSchema.default("on-risk"),
  outputFormat: OutputFormatSchema.default("text"),
  stream: z.boolean().default(true),
  maxToolOutputChars: z.number().int().positive().default(8_000),
  commandTimeoutMs: z.number().int().positive().default(30_000),
  shellAllowlist: z.array(z.string()).default([
    "cat",
    "echo",
    "git",
    "ls",
    "node",
    "npm",
    "pnpm",
    "pwd",
    "rg",
    "sed",
  ]),
  validationCommands: z.array(z.array(z.string())).default([]),
  allowedRoots: z.array(z.string()).default([]),
  networkAllowlist: z.array(z.string()).default([]),
  mcpServers: z.array(MCPServerConfigSchema).default([]),
});

export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type OutputFormat = z.infer<typeof OutputFormatSchema>;
export type OperatorMode = z.infer<typeof OperatorModeSchema>;
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;
export type ToolCategory = z.infer<typeof ToolCategorySchema>;
export type ChatTurnRole = z.infer<typeof ChatTurnRoleSchema>;
export type ChatSessionStatus = z.infer<typeof ChatSessionStatusSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type MCPToolDefinition = z.infer<typeof MCPToolDefinitionSchema>;
export type MCPResourceDefinition = z.infer<typeof MCPResourceDefinitionSchema>;
export type MCPResourceTemplate = z.infer<typeof MCPResourceTemplateSchema>;
export type MCPDiscovery = z.infer<typeof MCPDiscoverySchema>;
export type MCPToolResult = z.infer<typeof MCPToolResultSchema>;
export type AgentStepState = z.infer<typeof AgentStepStateSchema>;
export type ExecutorAction = z.infer<typeof ExecutorActionSchema>;
export type PatchProposal = z.infer<typeof PatchProposalSchema>;
export type TerminalSessionState = z.infer<typeof TerminalSessionStateSchema>;
export type ChatTurnRecord = z.infer<typeof ChatTurnRecordSchema>;
export type ChatSessionState = z.infer<typeof ChatSessionStateSchema>;
export type InteractiveSessionState = z.infer<typeof InteractiveSessionStateSchema>;
export type ExecutorStepMemory = z.infer<typeof ExecutorStepMemorySchema>;
export type RunBudgetState = z.infer<typeof RunBudgetStateSchema>;
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type HarnessRunState = z.infer<typeof HarnessRunStateSchema>;
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type MetricRecord = z.infer<typeof MetricRecordSchema>;
export type ContextSource = z.infer<typeof ContextSourceSchema>;
export type AgentContextSnapshot = z.infer<typeof AgentContextSnapshotSchema>;
export type ChatEventType = z.infer<typeof ChatEventTypeSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export type LLMRoleOverride = z.infer<typeof LLMRoleOverrideSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
