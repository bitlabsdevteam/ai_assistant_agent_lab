# Multi-Agent CLI Solution Implementation Guide

This document is the implementation blueprint for building a production-ready multi-agentic system from scratch. The target product is a command-line interface that coordinates three core agents:

- Analyzer Agent: understands the user's request, gathers context, decomposes work, identifies risks, and produces an execution plan.
- Executor Agent: performs the planned work through tools, code changes, shell commands, API calls, and structured workflows.
- Evaluator Agent: verifies outputs, checks quality, validates requirements, detects regressions, and decides whether the result is ready or must be improved.

The final product must be suitable for production use and deployment. That means the system must include a stable CLI, deterministic configuration, typed internal contracts, test coverage, structured logs, failure recovery, secure secret handling, deployment automation, and operational documentation.

## 1. Product Definition

### 1.1 Goal

Build a CLI-first multi-agent orchestration system that can accept a user task, analyze it, execute it through a controlled tool layer, evaluate the result, and return a clear final report.

### 1.2 Core User Flow

```text
User runs CLI command
  -> CLI validates arguments and loads config
  -> Orchestrator creates a run
  -> Analyzer Agent creates task plan
  -> Executor Agent performs approved actions
  -> Evaluator Agent checks completion and quality
  -> Orchestrator loops if fixes are required
  -> CLI prints final result and writes artifacts
```

### 1.3 Non-Goals For The First Production Version

- Do not build a graphical interface.
- Do not allow unrestricted shell, filesystem, or network access.
- Do not rely on prompt text alone for critical state transitions.
- Do not skip evaluation because the executor reports success.
- Do not store secrets, API keys, or credentials in run artifacts.

## 2. Recommended Technology Stack

This product must be implemented in TypeScript, following the style of production CLI agent systems such as Claude Code and Codex: a Node.js command-line runtime, strongly typed internal contracts, provider adapters, explicit tool permissions, durable run artifacts, and a clear separation between planning, execution, and evaluation.

Recommended stack:

- Language: TypeScript 5.x
- Runtime: Node.js 22 LTS or newer
- Package manager: `pnpm`
- CLI framework: `commander` or `yargs`
- Runtime validation: `zod`
- Config: environment variables plus optional TOML/YAML/JSON config loaded through a typed settings module
- HTTP client: built-in `fetch` or `undici`
- LLM provider adapter: internal abstraction over provider SDKs and HTTP APIs
- Logging: `pino` with pretty output in development and JSON output in production
- Testing: `vitest`
- Build tool: `tsup` or `tsx` for development plus `tsc --noEmit` for type checking
- Formatting and linting: Prettier and ESLint
- Deployment: npm package, standalone Docker image, and optional single-file bundled binary

### 2.1 TypeScript Implementation Rules

The implementation must follow these rules:

- Use strict TypeScript with `"strict": true`, `"noUncheckedIndexedAccess": true`, and `"exactOptionalPropertyTypes": true`.
- Use ESM modules unless a deployment target requires CommonJS.
- Put all runtime data contracts in Zod schemas and derive TypeScript types from those schemas.
- Validate every LLM response before using it.
- Validate every tool input before execution.
- Keep provider SDK types behind internal interfaces so the rest of the product is provider-neutral.
- Keep CLI rendering separate from orchestration logic.
- Keep tools side-effect aware: read-only tools, workspace mutation tools, network tools, and privileged tools must have separate permission checks.
- Prefer `node:fs/promises`, `node:path`, `node:child_process`, `node:stream`, and `AbortController` over ad hoc wrappers.
- Use structured errors with machine-readable error codes.
- Do not use global mutable state for run context.

### 2.2 Package Scripts

The first production version should provide these package scripts:

```json
{
  "scripts": {
    "dev": "tsx src/cli.ts",
    "build": "tsup src/cli.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "doctor": "node dist/cli.js doctor"
  }
}
```

The package should expose the executable through the `bin` field:

```json
{
  "bin": {
    "little-helper": "./dist/cli.js"
  }
}
```

## 3. Target Repository Structure

Create the project using this structure:

```text
little_helper_agent/
  AGENTS.MD
  README.md
  package.json
  pnpm-lock.yaml
  tsconfig.json
  tsup.config.ts
  eslint.config.js
  prettier.config.js
  .env.example
  .gitignore
  Dockerfile
  docker-compose.yml
  src/
    index.ts
    cli.ts
    config.ts
    logger.ts
    schemas.ts
    orchestrator.ts
    agents/
      analyzer.ts
      executor.ts
      evaluator.ts
      base.ts
    llm/
      client.ts
      providers.ts
      prompts.ts
    tools/
      base.ts
      shell.ts
      filesystem.ts
      web.ts
      registry.ts
    harness/
      controller.ts
      state-machine.ts
      checkpoint-manager.ts
      scheduler.ts
      lease-manager.ts
      recovery.ts
      approvals.ts
      budget-manager.ts
      finalizer.ts
    memory/
      run-store.ts
      artifact-store.ts
    policy/
      permissions.ts
      safety.ts
    telemetry/
      events.ts
      metrics.ts
  tests/
    unit/
    integration/
    e2e/
  docs/
    architecture.md
    deployment.md
    operations.md
```

## 4. Architecture

### 4.1 Main Components

#### CLI

The CLI is the only user interface for the first production version. It must:

- Parse commands and options.
- Validate configuration.
- Create a unique run ID.
- Stream progress to stdout.
- Write machine-readable artifacts to disk.
- Return meaningful exit codes.
- Include a `#!/usr/bin/env node` shebang in the compiled entrypoint.
- Keep terminal rendering, spinners, and progress output outside the orchestration core.

#### Orchestrator

The orchestrator owns the run lifecycle. It must:

- Start and stop runs.
- Route messages between agents.
- Enforce iteration limits.
- Persist run state.
- Apply safety policy before tool execution.
- Decide whether to continue, retry, ask for clarification, or fail.

#### Analyzer Agent

The analyzer converts an ambiguous user task into a structured plan. It must:

- Restate the objective.
- Identify assumptions and unknowns.
- Inspect allowed context.
- Break the task into ordered steps.
- Define success criteria.
- Identify required tools and permissions.
- Estimate risk level.

#### Executor Agent

The executor performs planned actions. It must:

- Consume a structured plan.
- Use tools through the approved tool interface.
- Record every action and result.
- Stop when blocked instead of improvising unsafe actions.
- Produce a structured execution report.

#### Evaluator Agent

The evaluator verifies the result independently. It must:

- Compare outputs against success criteria.
- Run tests, checks, or validation commands when available.
- Detect incomplete work.
- Detect unsafe or non-production behavior.
- Return pass, fail, or needs-revision with actionable feedback.

#### Tool Layer

Agents must not call raw shell, filesystem, network, or provider APIs directly. All external effects go through tools that enforce:

- Permission checks.
- Input validation.
- Timeouts.
- Logging.
- Output truncation.
- Secret redaction.
- Dry-run behavior where possible.

#### Context Manager

The runtime should include an explicit context manager responsible for:

- Selecting relevant files, diffs, logs, and prior events.
- Summarizing older context when token pressure grows.
- Preserving authoritative instructions separately from transient evidence.
- Recording which sources were used for each major decision.

#### Tool Registry

The runtime should include a registry that:

- Lists built-in tools.
- Registers MCP-discovered tools.
- Exposes tool metadata for planning and execution.
- Enforces a single normalized calling path.

#### Policy And Approval Engine

The runtime should include a policy engine that:

- Resolves permissions by tool category, path, command, server, and risk level.
- Decides whether an action is allowed, denied, or requires approval.
- Generates approval payloads for the CLI.
- Records policy decisions for audit and replay.

#### Process And PTY Manager

The runtime should include a terminal/process manager for command execution.

It should support:

- One-shot commands with captured stdout, stderr, and exit code.
- Interactive PTY sessions when a tool truly requires a terminal.
- Polling, cancellation, and timeout handling.
- Session reuse for long-running commands when policy allows it.

#### Memory And Artifacts

The system must distinguish between:

- Run state: structured internal state needed to continue a run.
- Artifacts: user-facing outputs such as reports, generated files, patches, logs, and validation results.
- Long-term memory: optional durable knowledge, disabled by default for production privacy.

#### Harness Runtime

The system should include a harness runtime around the agents. This is the control plane that starts runs, persists state, manages retries, watches heartbeats, resumes interrupted work, and decides when a long-running run should continue, pause, escalate, or stop.

### 4.2 Core Agentic Runtime Features

The system must explicitly implement the runtime features that make CLI coding agents like Claude Code and Codex useful in practice.

#### ReAct Execution Pattern

The executor loop should follow a ReAct-style pattern:

```text
observe task and current state
reason about next best step
choose a tool or response action
execute the action
observe the result
update working state
repeat until done, blocked, or evaluation is needed
```

Implementation requirements:

- Keep reasoning internal and structured.
- Keep actions explicit and machine-validated.
- Separate "thinking" from "doing" in the runtime state.
- Do not allow free-form prose to trigger side effects.
- Require every side-effecting action to map to a typed tool call.

#### Plan-Then-Act Coordination

The multi-agent design should combine two patterns rather than picking only one:

- Analyzer Agent: plan-first behavior for decomposition, risk analysis, and success criteria.
- Executor Agent: ReAct behavior for iterative tool use inside each approved plan step.
- Evaluator Agent: independent verification and critique after execution.

This hybrid approach is closer to production coding agents than a pure planner or a pure reactive agent.

#### Tool-Centric Action Model

The model must never perform side effects directly. Every mutation or inspection must happen through one of these action types:

- Local tool call: filesystem, shell, search, patch, diff, process inspection.
- MCP tool call: a tool exposed by an MCP server.
- Final response: a user-visible answer with no external side effect.
- Clarification request: a request for missing input when policy allows interaction.

#### Patch And Edit Workflow

The runtime should support file editing as a first-class behavior, not only shell execution.

Required editing capabilities:

- Read current file content before editing.
- Generate scoped diffs or patches.
- Validate target paths before writing.
- Preserve user changes outside the requested edit.
- Record changed files in the execution report.
- Prefer patch-style edits over full-file rewrites where feasible.

This is a core feature in coding agents such as Claude Code and Codex and should be treated as a primary tool capability.

#### Context Window Management

The runtime must manage context deliberately instead of appending everything forever.

Required strategies:

- Load only relevant files and command outputs.
- Summarize older run state when the transcript grows.
- Separate immutable instructions from transient context.
- Track which evidence supports each decision.
- Truncate or summarize large tool outputs before reusing them.
- Preserve enough structured state to resume a run without replaying the entire transcript.

#### Session And Resume Model

Each run should behave like a resumable session.

Required session features:

- Unique run/session ID.
- Phase and iteration tracking.
- Durable event log.
- Artifacts directory.
- Resume from the last durable checkpoint.
- Clear terminal status if a run is interrupted, cancelled, or blocked.

#### Streaming And Operator Visibility

CLI coding agents need to show progress while they work.

Required streaming features:

- Current phase display.
- Active agent display.
- Tool start and completion messages.
- Approval prompts when enabled.
- Final summarized result.
- Quiet and JSON modes for automation.

#### Model And Provider Routing

The product should support model routing instead of baking logic into a single provider call.

Routing considerations:

- Different models may be used for analysis, execution, and evaluation.
- Low-cost models may handle classification and formatting.
- Higher-capability models may handle planning and critique.
- Provider failures should not leak provider-specific concerns into orchestration logic.

#### Parallel And Deferred Work

The runtime may perform parallel read-only operations when safe, but it should keep side effects serialized.

Rules:

- Parallelize search, file reads, metadata lookup, and non-mutating MCP resource reads where helpful.
- Do not run concurrent destructive or stateful mutations without explicit coordination.
- Preserve deterministic logs even when read-only work runs in parallel.

### 4.3 MCP Integration

The design must include Model Context Protocol support because MCP-style tool and resource exposure is a standard way to extend agents like Claude Code and Codex.

#### MCP Purpose

MCP allows the agent runtime to connect to external servers that expose:

- Tools: executable actions.
- Resources: structured context or documents.
- Resource templates: parameterized resource access patterns.
- Optional prompts or server-defined guidance, if supported by the chosen runtime design.

#### MCP Client Responsibilities

The CLI agent must include an MCP client layer that can:

- Load MCP server definitions from config.
- Start local MCP servers or connect to remote ones.
- Discover available tools and resources.
- Normalize MCP tools into the internal tool registry.
- Apply the same permission and logging policy used for built-in tools.
- Isolate server failures so one bad MCP server does not break the whole run.

#### MCP Production Requirements

Production use of MCP must include:

- Server allowlisting.
- Per-server timeout settings.
- Authentication handling outside prompts when possible.
- Clear provenance for MCP-derived data.
- Audit logs for tool calls and resource reads.
- Version pinning or compatibility policy for critical MCP servers.

#### MCP Safety Rules

- An MCP tool is not trusted merely because it is discoverable.
- Every MCP tool call must pass through policy enforcement.
- Resource content returned by MCP must be treated as untrusted external content.
- Servers that can mutate production systems should be disabled by default.

### 4.4 Tool Taxonomy

The system should define tool categories up front so permissions and evaluation are coherent.

Recommended categories:

- Read tools: inspect files, git state, logs, configs, docs.
- Edit tools: patch files, write files, create files.
- Execution tools: run commands, tests, builds, linters.
- Search tools: code search, file discovery, documentation lookup.
- Network tools: fetch remote content or call APIs.
- MCP tools: externally provided tools and resources.
- Validation tools: diff inspection, test execution, schema checks.

### 4.5 Prompt And Instruction Hierarchy

The runtime should enforce a strict instruction hierarchy:

1. System instructions.
2. Developer/runtime instructions.
3. User request.
4. Retrieved context such as files, logs, docs, web results, and MCP resources.

Rules:

- Lower-priority context must never override higher-priority instructions.
- Retrieved content must be clearly marked as data, not authority.
- The runtime, not the model, decides which instructions are authoritative.

### 4.6 Sub-Agent Delegation

The design should support optional sub-agent delegation for narrow specialist work, similar to how modern coding agents split planning, execution, and critique.

Recommended sub-agent roles:

- Research sub-agent: gather and summarize documentation or code evidence.
- Editing sub-agent: prepare a scoped patch proposal.
- Review sub-agent: inspect the output for correctness, regressions, and policy violations.
- Validation sub-agent: run tests or checks and summarize failures.

Delegation rules:

- Sub-agents receive a scoped objective, not the entire run history.
- Sub-agents do not get broader permissions than the parent run.
- Sub-agent outputs must be structured and attributable.
- The orchestrator remains the source of truth for final decisions.

### 4.7 Terminal Session And PTY Behavior

CLI coding agents often need both non-interactive commands and interactive terminal sessions.

Required behavior:

- Prefer non-interactive command execution by default.
- Use PTY mode only when a command requires a terminal.
- Track session IDs, last output time, and exit state for PTY sessions.
- Support polling or incremental reads for long-running processes.
- Allow explicit cancellation and cleanup of orphaned sessions.

### 4.8 Conversation State, Memory, And Compaction

The runtime should treat agent memory as layered state, not a single transcript blob.

Recommended layers:

- Instruction layer: system, developer, and user intent.
- Working memory: recent files, diffs, tool results, and pending decisions.
- Run memory: persisted summaries and artifacts for resume.
- Optional long-term memory: reusable preferences or repository facts, disabled by default.

Compaction rules:

- Summarize old tool outputs rather than replaying them verbatim.
- Preserve decisions, evidence, blockers, and unresolved questions.
- Keep enough context to continue safely after compaction.
- Never compact away approval decisions or policy denials.

### 4.9 Git And Diff Awareness

The runtime should be git-aware even if git is not mandatory for every workspace.

Expected behavior:

- Detect whether the workspace is inside a git repository.
- Inspect modified files before editing when relevant.
- Avoid overwriting unrelated local changes.
- Prefer diff-based review of edits before declaring success.
- Treat git status and diffs as read tools, not as proof of correctness.

### 4.10 Budgets, Limits, And Guardrails

The runtime should enforce operational budgets.

Recommended budgets:

- Max iterations per run.
- Max tool calls per phase.
- Max command runtime.
- Max prompt/context size.
- Max output size per tool call.
- Optional token and cost budgets by run.

When a budget is approached or exceeded, the runtime should:

- Summarize progress.
- Prefer lower-cost read actions.
- Reduce context size safely.
- Stop with a structured budget error when necessary.

### 4.11 Baseline Feature Checklist

The first production version should explicitly include these baseline agentic features:

- Multi-agent orchestration: analyzer, executor, evaluator.
- ReAct-style execution inside executor steps.
- Typed tool registry with policy enforcement.
- Built-in tools for search, read, edit, patch, shell, PTY, git, web, and validation.
- MCP discovery for tools, resources, and resource templates.
- Structured context assembly and memory compaction.
- Session persistence and resumable runs.
- Approval and escalation workflow.
- Sandboxed execution boundaries.
- Evaluation and review loop before completion.
- Streaming CLI progress and machine-readable JSON mode.
- Budget and limit enforcement.

If any item above is omitted, the product is not yet equivalent to the baseline expectations for CLI coding agents like Claude Code and Codex.

### 4.12 Harness Engineering

Harness engineering is the design and implementation of the runtime scaffold around the agents. It is not the analyzer, executor, or evaluator prompt logic itself. It is the system that makes those agents dependable over time.

In this project, harness engineering should be treated as a first-class subsystem with these responsibilities:

- Start, pause, resume, cancel, and finalize runs.
- Persist durable checkpoints after every meaningful state transition.
- Manage long-running sessions, heartbeats, leases, retries, and timeouts.
- Route work between the analyzer, executor, evaluator, tools, and optional sub-agents.
- Apply policy, approvals, budgets, and sandbox rules consistently.
- Recover from process crashes, network failures, provider outages, and partial tool execution.
- Produce a full audit trail for every decision and side effect.

#### Why Harness Engineering Matters

Without a harness, an agent is only a short-lived prompt loop. It may work in a demo, but it will not behave like a production system.

The harness is what makes the agent:

- Long-running instead of single-shot.
- Recoverable instead of fragile.
- Observable instead of opaque.
- Governed instead of improvisational.
- Safe to operate repeatedly in production.

#### Harness Responsibilities In This Project

For this CLI multi-agent system, the harness should own:

- Run lifecycle management.
- Work scheduling between phases.
- Durable state and checkpoint writes.
- Session and PTY supervision.
- Approval wait states.
- Retry and backoff policy.
- Failure classification.
- Resume and replay logic.
- Budget tracking.
- Health monitoring and heartbeats.
- Finalization and artifact sealing.

#### Harness Architecture

The recommended harness architecture is:

```text
CLI command
  -> Harness controller
  -> Run store and checkpoint store
  -> Scheduler / phase dispatcher
  -> Agent runtime (analyzer, executor, evaluator, sub-agents)
  -> Tool registry and MCP bridge
  -> Policy / approval engine
  -> Telemetry and artifact writers
```

Recommended harness components:

- Harness controller: the top-level process that owns a run.
- Run state store: durable structured state for resume and replay.
- Checkpoint manager: writes safe recovery points after each phase or critical tool call.
- Scheduler: chooses the next unit of work and enforces ordering.
- Session supervisor: watches long-running tool sessions and PTY state.
- Lease and heartbeat manager: prevents orphaned or duplicated workers.
- Retry manager: handles transient failure retry rules.
- Budget manager: tracks iteration, token, cost, and time budgets.
- Finalizer: closes the run, emits artifacts, and writes final status.

#### How The Harness Should Work

The harness should execute runs as a state machine rather than as an ad hoc while-loop.

A recommended state model:

```text
created
planning
awaiting_approval
executing
evaluating
revising
paused
blocked
completed
failed
cancelled
```

Rules:

- Only the harness may change the run state.
- Every state transition must be persisted before control moves on.
- Tool calls and PTY sessions must reference the active run state and checkpoint version.
- Resume starts from the last durable state, not from memory of what likely happened.

#### Long-Running Agent Requirements

To make this project a true long-running agent, the harness must support:

- Runs that survive process restarts.
- Runs that wait for human approval without losing context.
- Runs that span many tool calls and many evaluation cycles.
- Runs that can pause on external dependencies and resume later.
- Runs that can recover from partial failure without repeating destructive actions.
- Runs that can compact context while preserving safety-critical facts.

#### Checkpointing Model

Checkpointing should be explicit and frequent.

Create checkpoints after:

- Run creation.
- Analyzer output.
- Approval request creation.
- Approval decision receipt.
- Every side-effecting tool call.
- PTY session start and completion.
- Evaluator output.
- Final run completion or failure.

Each checkpoint should store:

- Current run state.
- Current phase and iteration.
- Latest structured agent outputs.
- Budget consumption.
- Active approvals.
- Active sessions.
- Last successful checkpoint ID.

#### Heartbeats, Leases, And Recovery

Long-running work needs liveness control.

Recommended behavior:

- The active harness worker should renew a lease on the run periodically.
- Long-running tool sessions should emit heartbeats or activity timestamps.
- If the lease expires, another worker or a recovery command may adopt the run safely.
- Stale PTY sessions should be reconciled before resume.
- Recovery logic should classify whether the last step was committed, unknown, or failed.

#### Retry, Replay, And Idempotency

The harness should distinguish between retrying a tool call, replaying a state transition, and resuming a run.

Definitions:

- Retry: rerun a transiently failed action under retry policy.
- Replay: rebuild in-memory state from durable events and checkpoints.
- Resume: continue the run from the latest known safe point.

Rules:

- Never retry destructive actions blindly.
- Never replay a side effect unless idempotency is proven.
- Resume should prefer checkpoint continuation over re-executing unknown mutations.

#### Approval Wait States

Long-running agents often stop on approvals. The harness must treat approvals as durable wait states, not as temporary prompts.

Required behavior:

- Persist the approval request with exact action details.
- Move the run to `awaiting_approval`.
- Resume only after an explicit approval or denial event is recorded.
- Expire or invalidate stale approval requests when the underlying plan changes.

#### Harness Observability

The harness should produce its own telemetry in addition to agent and tool telemetry.

Harness events should include:

- `harness.run_started`
- `harness.checkpoint_written`
- `harness.lease_renewed`
- `harness.awaiting_approval`
- `harness.resumed`
- `harness.recovered`
- `harness.run_finalized`

Harness metrics should include:

- Checkpoint frequency.
- Resume success rate.
- Recovery success rate.
- Approval wait duration.
- Heartbeat freshness.
- Lease expiration count.

#### Harness Failure Modes

The harness design should explicitly cover:

- Process crash during tool execution.
- Provider timeout after a tool already ran.
- PTY session orphaning.
- Approval granted after the run was already revised.
- Duplicate resume attempts.
- Stale checkpoint versus live session mismatch.
- Partial artifact writes.

For each case, the harness should define:

- How the failure is detected.
- Which state the run moves into.
- Whether recovery is automatic or manual.
- Which artifacts and logs prove what happened.

#### Harness Engineering In This Project

For this repository, implement harness engineering as a separate module cluster rather than scattering it across the agents:

```text
src/
  harness/
    controller.ts
    state-machine.ts
    checkpoint-manager.ts
    scheduler.ts
    lease-manager.ts
    recovery.ts
    approvals.ts
    budget-manager.ts
    finalizer.ts
```

Responsibilities:

- `controller.ts`: starts and coordinates runs.
- `state-machine.ts`: owns valid state transitions.
- `checkpoint-manager.ts`: writes and restores checkpoints.
- `scheduler.ts`: selects the next phase or work item.
- `lease-manager.ts`: maintains run ownership and liveness.
- `recovery.ts`: resumes interrupted or uncertain runs.
- `approvals.ts`: manages approval wait states and decisions.
- `budget-manager.ts`: tracks operational budgets.
- `finalizer.ts`: writes final artifacts and status.

#### Implementation Strategy For Long-Running Operation

Implement the harness in layers:

1. Add a durable run state machine.
2. Add checkpoint writes after every phase.
3. Add resume from checkpoint.
4. Add approval wait states.
5. Add PTY/session supervision.
6. Add lease and heartbeat logic.
7. Add recovery and reconciliation logic.
8. Add budget enforcement and compaction triggers.

Do not try to make the agent long-running by only increasing loop counts or command timeouts. The harness is the mechanism that makes long-running behavior correct.

## 5. Data Contracts

Use typed models for every agent boundary. Do not pass free-form strings as the main control mechanism.

### 5.1 Run Request

Define schemas in `src/schemas.ts` and export both runtime validators and inferred TypeScript types.

```ts
import { z } from "zod";

export const RunRequestSchema = z.object({
  task: z.string().min(1),
  workingDirectory: z.string().min(1),
  profile: z.string().default("default"),
  dryRun: z.boolean().default(false),
  maxIterations: z.number().int().positive().default(3),
  metadata: z.record(z.string(), z.string()).default({}),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;
```

### 5.2 Plan Step

```ts
export const PlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  agent: z.literal("executor"),
  toolNames: z.array(z.string()),
  expectedOutput: z.string().min(1),
  approvalRequired: z.boolean().default(false),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
```

### 5.3 Analysis Result

```ts
export const RiskLevelSchema = z.enum(["low", "medium", "high"]);

export const AnalysisResultSchema = z.object({
  objective: z.string().min(1),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
  successCriteria: z.array(z.string()),
  plan: z.array(PlanStepSchema),
  requiredTools: z.array(z.string()),
  riskLevel: RiskLevelSchema,
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
```

### 5.4 Execution Report

```ts
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  inputSummary: z.string(),
  status: z.enum(["success", "failed", "denied", "skipped"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  outputArtifact: z.string().optional(),
  error: z.string().optional(),
});

export const ExecutionReportSchema = z.object({
  completedSteps: z.array(z.string()),
  skippedSteps: z.array(z.string()),
  toolCalls: z.array(ToolCallRecordSchema),
  changedFiles: z.array(z.string()),
  producedArtifacts: z.array(z.string()),
  blockers: z.array(z.string()),
  summary: z.string(),
});

export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;
```

### 5.5 Evaluation Result

```ts
export const EvaluationResultSchema = z.object({
  status: z.enum(["pass", "fail", "needs_revision"]),
  passedCriteria: z.array(z.string()),
  failedCriteria: z.array(z.string()),
  requiredRevisions: z.array(z.string()),
  validationCommands: z.array(z.string()),
  productionReadinessNotes: z.array(z.string()),
});

export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
```

### 5.6 MCP Server Configuration

The runtime should also define typed configuration for MCP connectivity.

```ts
export const MCPServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
  url: z.string().url().optional(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30_000),
  allowedTools: z.array(z.string()).default([]),
});

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
```

### 5.7 Agent Step State

The ReAct executor should persist structured step state, not only a final summary.

```ts
export const AgentStepStateSchema = z.object({
  stepId: z.string(),
  observation: z.string(),
  chosenActionType: z.enum(["tool_call", "final_response", "clarification"]),
  chosenActionName: z.string(),
  rationaleSummary: z.string(),
  resultSummary: z.string().optional(),
});

export type AgentStepState = z.infer<typeof AgentStepStateSchema>;
```

### 5.8 Terminal Session State

Interactive command execution should also have typed session state.

```ts
export const TerminalSessionStateSchema = z.object({
  sessionId: z.string(),
  command: z.array(z.string()),
  mode: z.enum(["non_interactive", "pty"]),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled", "timed_out"]),
  exitCode: z.number().int().optional(),
});

export type TerminalSessionState = z.infer<typeof TerminalSessionStateSchema>;
```

### 5.9 Run Budget State

The runtime should persist budget consumption for safety and observability.

```ts
export const RunBudgetStateSchema = z.object({
  maxIterations: z.number().int().positive(),
  maxToolCalls: z.number().int().positive().optional(),
  maxPromptChars: z.number().int().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
  toolCallsUsed: z.number().int().nonnegative().default(0),
  promptCharsUsed: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative().default(0),
});

export type RunBudgetState = z.infer<typeof RunBudgetStateSchema>;
```

### 5.10 Harness Run State

The harness should persist an explicit state machine record for every run.

```ts
export const HarnessRunStateSchema = z.object({
  runId: z.string(),
  status: z.enum([
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
  ]),
  phase: z.string(),
  iteration: z.number().int().nonnegative(),
  checkpointId: z.string().optional(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  lastHeartbeatAt: z.string().optional(),
});

export type HarnessRunState = z.infer<typeof HarnessRunStateSchema>;
```

### 5.11 Checkpoint Record

The checkpoint manager should write durable recovery records.

```ts
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

export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;
```

## 6. CLI Interface

### 6.1 Command Overview

The CLI binary should be named `little-helper` unless the product name changes.

Required commands:

```text
little-helper run "TASK"
little-helper plan "TASK"
little-helper eval RUN_ID
little-helper status RUN_ID
little-helper logs RUN_ID
little-helper artifacts RUN_ID
little-helper config validate
little-helper version
```

Optional production commands:

```text
little-helper resume RUN_ID
little-helper cancel RUN_ID
little-helper doctor
little-helper tools list
little-helper tools inspect TOOL_NAME
little-helper mcp list
little-helper mcp inspect SERVER_NAME
little-helper approvals RUN_ID
little-helper sessions RUN_ID
little-helper checkpoints RUN_ID
little-helper recover RUN_ID
```

### 6.2 `run`

Runs the full analyzer -> executor -> evaluator workflow.

```text
little-helper run "Create a FastAPI health endpoint"
```

Options:

```text
--cwd PATH                  Working directory for the run
--profile NAME              Config profile
--dry-run                   Analyze and plan without external side effects
--max-iterations N          Maximum analyzer/executor/evaluator loops
--approval-mode MODE        never, on-risk, always
--output json|text          Output format
--artifact-dir PATH         Directory for run artifacts
--no-stream                 Disable streaming progress
```

Expected behavior:

- Exit `0` when evaluation passes.
- Exit `1` for user or task failure.
- Exit `2` for configuration errors.
- Exit `3` for policy or permission denial.
- Exit `4` for unexpected internal errors.

### 6.3 `plan`

Runs only the Analyzer Agent and prints a structured plan.

```text
little-helper plan "Refactor the payment module"
```

This command must not execute tools with side effects.

### 6.4 `eval`

Runs the Evaluator Agent against an existing run.

```text
little-helper eval 20260524-101500-a13f
```

This is useful for rechecking a run after manual changes.

### 6.5 `status`

Prints run state.

```text
little-helper status 20260524-101500-a13f
```

Output should include:

- Run ID.
- Current phase.
- Current iteration.
- Started time.
- Last update time.
- Final status if complete.
- Artifact directory.

### 6.6 `doctor`

Checks whether the CLI is ready for production use on the current machine.

Validation should include:

- Node.js version.
- Package manager availability.
- Config file validity.
- Required environment variables.
- LLM provider connectivity if enabled.
- Writable artifact directory.
- Tool availability.
- Security policy validity.

## 7. Configuration

### 7.1 Configuration Sources

Load configuration in this order:

1. Built-in defaults.
2. Project config file.
3. User config file.
4. Environment variables.
5. CLI flags.

Later sources override earlier sources.

### 7.2 Example `.env.example`

```text
LITTLE_HELPER_ENV=development
LITTLE_HELPER_LOG_LEVEL=INFO
LITTLE_HELPER_ARTIFACT_DIR=.little-helper/runs
LITTLE_HELPER_LLM_PROVIDER=openai
LITTLE_HELPER_LLM_MODEL=
LITTLE_HELPER_MAX_ITERATIONS=3
LITTLE_HELPER_APPROVAL_MODE=on-risk
```

Do not include real API keys in `.env.example`.

### 7.3 Production Config Requirements

Production configuration must define:

- Explicit environment name.
- Explicit model/provider selection.
- Model routing by agent role when multiple models are used.
- Artifact retention policy.
- Logging level.
- Permission policy.
- MCP server definitions and allowlists if MCP is enabled.
- Timeout values.
- Maximum tool output size.
- Maximum run iterations.

## 8. Agent Behavior

### 8.1 Analyzer Agent Prompt Contract

The Analyzer Agent must return JSON that matches `AnalysisResult`.

The prompt must instruct the model to:

- Be specific.
- Prefer small ordered steps.
- Surface assumptions.
- Identify tools needed for each step.
- Mark risky or destructive actions.
- Define measurable success criteria.
- Avoid executing or claiming execution.

### 8.2 Executor Agent Prompt Contract

The Executor Agent must return JSON that matches `ExecutionReport`.

The prompt must instruct the model to:

- Follow the analyzer plan.
- Use only approved tools.
- Stop on permission denial.
- Record changed files and artifacts.
- Report blockers clearly.
- Avoid hiding failed commands.

### 8.3 Evaluator Agent Prompt Contract

The Evaluator Agent must return JSON that matches `EvaluationResult`.

The prompt must instruct the model to:

- Validate against success criteria.
- Prefer objective checks over subjective claims.
- Review execution logs.
- Run configured validation commands where safe.
- Fail incomplete or unverified work.
- Provide exact revision instructions.

### 8.4 Executor ReAct Rules

The executor should use a bounded ReAct loop within each plan step.

Rules:

- Observe the current step goal and available evidence.
- Choose one next action, not many speculative actions at once.
- Prefer the cheapest read action that reduces uncertainty.
- Use edits only after enough evidence has been gathered.
- Re-check outcomes after each side-effecting action.
- Escalate to evaluation or revision when the step appears complete.
- Stop and report blockers instead of hallucinating success.

### 8.5 Context Assembly Rules

Before any agent call, the runtime should assemble context from these buckets:

- Stable instructions.
- User task.
- Current run state.
- Relevant files and diffs.
- Recent tool outputs.
- Relevant MCP resources.
- Evaluation feedback from the previous loop.

Context assembly must be selective. The runtime should not dump the whole workspace into the prompt.

### 8.6 Tool Selection Rules

The runtime should bias tool selection the way production coding agents do:

- Use search tools before reading many files blindly.
- Use read tools before edit tools.
- Use patch tools before full rewrites.
- Use validation tools before declaring success.
- Use MCP tools only when the required capability is not better served by a built-in tool.

### 8.7 Evaluation Modes

The evaluator should support at least three operating modes:

- Lightweight: schema and structural checks only.
- Standard: success criteria plus local validation commands.
- Strict: standard evaluation plus production-readiness gates such as lint, tests, and policy checks.

## 9. Orchestration Loop

The core loop must be deterministic and bounded.

```text
create run
load config
validate policy
analysis = analyzer.analyze(request)
for iteration in max_iterations:
    execution = executor.execute(analysis.plan)
    evaluation = evaluator.evaluate(analysis, execution)
    if evaluation.status == "pass":
        complete run
        return success
    if evaluation.status == "fail":
        fail run
        return failure
    analysis = analyzer.revise_plan(
        previous_analysis=analysis,
        execution=execution,
        evaluation=evaluation
    )
fail run because max iterations reached
```

Rules:

- Never loop indefinitely.
- Persist state after every phase.
- Preserve complete audit trail.
- Do not execute new tool calls during evaluation unless policy allows it.
- Require approval before destructive or high-risk actions.

## 10. Tool Design

### 10.1 Base Tool Interface

Every tool should implement:

```ts
import type { z } from "zod";

export interface ToolContext {
  runId: string;
  workingDirectory: string;
  dryRun: boolean;
  permissions: string[];
  signal: AbortSignal;
}

export interface Tool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  validate(input: z.infer<TInput>, context: ToolContext): Promise<void> | void;
  run(input: z.infer<TInput>, context: ToolContext): Promise<z.infer<TOutput>>;
}
```

### 10.2 Required Tools

The first production version should ship with built-in tools and allow MCP-backed extensions.

Built-in tools:

- Filesystem read and write.
- Patch/diff edit tool.
- Shell execution tool.
- PTY/process session tool.
- Code search and file listing tool.
- Git status and diff inspection tool.
- Web fetch tool.
- Validation tool wrapper for tests, lint, and build commands.

Extended tools:

- MCP-provided tools exposed through the same internal registry.

Every tool should declare:

- Name.
- Category.
- Risk level.
- Side-effect level.
- Required permission scope.
- Input schema.
- Output schema.
- Timeout policy.
- Whether it is safe in dry-run mode.

#### Filesystem Tool

Capabilities:

- Read files inside allowed roots.
- Write files inside allowed roots.
- List files.
- Check file existence.
- Generate diffs.

Safety requirements:

- Block path traversal.
- Block writes outside allowed roots.
- Refuse binary writes unless explicitly enabled.
- Keep backups or patches for changed files.

#### Shell Tool

Capabilities:

- Run configured commands.
- Capture stdout and stderr.
- Enforce timeouts.
- Return exit codes.

Safety requirements:

- Use an allowlist for production.
- Block destructive commands by default.
- Require approval for package installation, deploys, database migrations, and delete operations.
- Do not invoke a shell string when an argument array is possible.

#### PTY/Process Tool

Capabilities:

- Start interactive terminal sessions.
- Poll or stream incremental output.
- Send input when policy allows it.
- Cancel or terminate active sessions.

Safety requirements:

- Use PTY only when non-interactive execution is insufficient.
- Enforce session timeouts and idle timeouts.
- Record session lifecycle events.
- Restrict interactive input for privileged commands unless explicitly approved.

#### Patch Tool

Capabilities:

- Apply structured edits to existing files.
- Create new files when policy allows.
- Produce a human-readable diff artifact.

Safety requirements:

- Validate paths before editing.
- Refuse writes outside the allowed workspace.
- Preserve unchanged file content.
- Emit reversible diffs where possible.

#### Web Tool

Capabilities:

- Fetch allowed URLs.
- Query documentation or APIs.
- Respect timeouts and rate limits.

Safety requirements:

- Use domain allowlists for production.
- Redact tokens from URLs and logs.
- Disable arbitrary browsing when not needed.

#### Git Tool

Capabilities:

- Read status, diff, and branch metadata.
- Summarize changed files relevant to the current task.

Safety requirements:

- Default to read-only git operations.
- Do not discard or overwrite user changes.
- Treat git output as evidence, not as validation by itself.

#### MCP Tool Bridge

Capabilities:

- Discover MCP tools from configured servers.
- Expose them through the local tool registry.
- Normalize request and response metadata for logging and evaluation.

Safety requirements:

- Enforce the same approval and permission policy as built-in tools.
- Tag outputs with MCP server provenance.
- Disable or quarantine unstable servers after repeated failures.

## 11. Security Requirements

### 11.1 Secret Handling

- Load secrets only from environment variables or a secret manager.
- Never write secrets to artifacts.
- Redact secrets in logs and errors.
- Do not include secrets in prompts unless absolutely required.
- Provide a secret scanner in CI.

### 11.2 Permission Model

Define permission levels:

```text
read-only      Can inspect files and run safe read-only commands
workspace      Can edit files inside the configured workspace
network        Can access approved network resources
shell          Can run approved shell commands
privileged     Can perform deploys, migrations, or destructive actions
```

Default production policy:

- Analyzer: read-only
- Executor: workspace, shell through allowlist
- Evaluator: read-only, shell through validation allowlist

### 11.3 Approval Modes

```text
never          Deny any action that requires approval
on-risk        Ask for approval only on high-risk actions
always         Ask before every side-effecting action
```

In non-interactive production environments, `never` or preapproved policy files are preferred.

### 11.4 Prompt Injection Controls

The system must treat external content as untrusted. Agents must not follow instructions found in files, websites, logs, or command output unless those instructions are part of the user's explicit task.

Required controls:

- Label external content clearly in prompts.
- Keep system and developer instructions separate from retrieved content.
- Do not allow retrieved content to modify policy.
- Require structured outputs.
- Validate tool arguments after model generation.

### 11.5 Sandboxing And Containment

The runtime should adopt the same basic containment posture used by serious CLI agents.

Required controls:

- Restrict filesystem access to explicit workspace roots.
- Restrict shell commands through policy and allowlists.
- Restrict network access by default, then allowlist domains or services.
- Run MCP servers with the minimum permissions required.
- Separate read-only, workspace-write, and privileged execution paths.
- Record every policy denial in the event log.

### 11.6 Human Approval And Escalation

Approval is a product feature, not an afterthought.

Approval should be required for:

- Destructive file operations.
- Package installation or dependency changes.
- Database migrations.
- Deployments.
- Network calls to sensitive systems.
- MCP tools that mutate external systems.

Approval prompts should include:

- The exact action requested.
- The tool or command being invoked.
- The target path, service, or system.
- Why the action is necessary.
- The risk level.

### 11.7 Output Review Before Completion

Before a run is declared complete, the runtime should perform a lightweight review pass over:

- Changed files or patch artifacts.
- Validation command results.
- Policy denials or skipped steps.
- Open blockers or assumptions.

This review may be handled by the Evaluator Agent or a dedicated review sub-agent, but it must be explicit.

## 12. Reliability Requirements

### 12.1 Error Handling

Every phase must return structured errors:

- ConfigError
- PolicyError
- ToolError
- LLMError
- ValidationError
- TimeoutError
- InternalError

The CLI must convert these into stable exit codes and useful messages.

### 12.2 Retry Policy

Use retries only for transient failures:

- Network timeouts.
- Rate limits.
- Temporary provider errors.

Do not retry:

- Invalid tool input.
- Permission denial.
- Failed tests.
- Deterministic validation errors.

### 12.3 Idempotency

The system should support safe resume behavior:

- Each run has a unique ID.
- Tool calls have unique IDs.
- Side-effecting calls record before and after state where possible.
- Resume must not repeat completed destructive steps automatically.

## 13. Observability

### 13.1 Structured Events

Log these events:

```text
run.created
run.completed
run.failed
agent.started
agent.completed
agent.failed
tool.started
tool.completed
tool.failed
policy.denied
evaluation.passed
evaluation.failed
harness.run_started
harness.checkpoint_written
harness.awaiting_approval
harness.lease_renewed
harness.resumed
harness.recovered
harness.run_finalized
```

Each event should include:

- Timestamp.
- Run ID.
- Agent name when applicable.
- Tool name when applicable.
- Duration.
- Status.
- Error code if failed.

### 13.2 Metrics

Track:

- Run count.
- Run success rate.
- Average run duration.
- Tool failure rate.
- Evaluation failure rate.
- LLM token usage.
- LLM provider latency.
- Approval requests.
- MCP server failure rate.
- Approval latency.
- PTY session count and failure rate.
- Estimated token/cost spend per run.

### 13.3 Artifacts

For each run, write:

```text
.little-helper/runs/RUN_ID/
  request.json
  analysis.json
  execution.json
  evaluation.json
  events.jsonl
  final-report.md
  artifacts/
```

Recommended additional artifacts for coding-agent runs:

- `step-trace.jsonl` for ReAct step summaries.
- `tool-calls.json` for normalized tool call records.
- `context-summary.md` for resumable condensed context.
- `diff.patch` when file edits were produced.
- `approvals.json` for approval requests and decisions.
- `sessions.json` for PTY/process session summaries.
- `checkpoints/` for durable checkpoint records.
- `harness-state.json` for the latest persisted run state.

## 14. Testing Strategy

### 14.1 Unit Tests

Cover:

- Config loading and precedence.
- Data model validation.
- Policy decisions.
- Tool input validation.
- Path safety.
- Exit code mapping.
- Agent output parsing.

### 14.2 Integration Tests

Cover:

- Full analyzer -> executor -> evaluator run with mocked LLM.
- CLI command behavior.
- Artifact creation.
- Resume behavior.
- Permission denial behavior.
- Max iteration behavior.

### 14.3 End-To-End Tests

Cover realistic tasks:

- Generate a small file.
- Modify an existing file.
- Run a validation command.
- Fail evaluation and revise.
- Stop on blocked permission.

### 14.4 Golden Tests

Use fixture tasks and expected structured outputs to prevent regressions in:

- Analyzer plans.
- Evaluation decisions.
- CLI output shape.
- Artifact layout.

### 14.5 Production Readiness Tests

Before deployment, verify:

- Docker image builds.
- CLI starts inside container.
- `doctor` passes in target environment.
- Logs are JSON in production mode.
- Secrets are redacted.
- Nonzero exit codes work correctly.
- Timeout behavior is enforced.

## 15. Implementation Phases

### Phase 0: Project Foundation

Objective: create the basic project skeleton.

Steps:

1. Create `package.json`.
2. Create `tsconfig.json`.
3. Add test directory.
4. Add ESLint configuration.
5. Add Prettier configuration.
6. Add `.env.example`.
7. Add `.gitignore`.
8. Add minimal README.
9. Add `src/cli.ts` and `src/index.ts`.
10. Add CI workflow if the repository uses GitHub.

Exit criteria:

- `pnpm exec little-helper version` or `node dist/cli.js version` works locally.
- `pnpm test` runs successfully.
- `pnpm lint`, `pnpm format:check`, and `pnpm typecheck` are documented.

### Phase 1: Data Models And Config

Objective: define typed contracts and deterministic configuration.

Steps:

1. Implement Zod schemas and inferred TypeScript types for `RunRequest`, `AnalysisResult`, `PlanStep`, `ExecutionReport`, and `EvaluationResult`.
2. Implement typed `Settings`.
3. Support env var loading.
4. Support CLI flag overrides.
5. Validate required production settings.
6. Add tests for config precedence.

Exit criteria:

- Invalid config fails before any agent runs.
- All model parsing failures return clear errors.
- Production mode refuses implicit defaults for critical settings.

### Phase 2: CLI Shell

Objective: expose the stable command interface.

Steps:

1. Implement `version`.
2. Implement `config validate`.
3. Implement `doctor`.
4. Implement placeholder `plan`, `run`, `eval`, `status`, `logs`, and `artifacts`.
5. Add output format support for `text` and `json`.
6. Add stable exit codes.

Exit criteria:

- CLI help text is clear.
- Each command has tests.
- Invalid arguments fail predictably.

### Phase 3: Run Store And Artifacts

Objective: persist all run state.

Steps:

1. Create run ID generation.
2. Create run directory layout.
3. Write request artifacts.
4. Write phase artifacts.
5. Write JSONL event log.
6. Add harness state persistence and checkpoint records.
7. Implement `status`, `logs`, and `artifacts`.

Exit criteria:

- A run can be inspected after the process exits.
- Corrupt or missing run IDs produce clear errors.
- Artifacts contain no secrets.
- A run can be resumed from the last durable checkpoint.

### Phase 4: LLM Provider Abstraction

Objective: isolate the product from provider-specific SDK details.

Steps:

1. Define an `LLMClient` TypeScript interface.
2. Implement provider adapter.
3. Add mock provider for tests.
4. Add timeout and retry handling.
5. Add token usage recording.
6. Add structured output parsing.

Exit criteria:

- Agents can use the mock provider in tests.
- Provider errors map to structured errors.
- Structured outputs are validated before use.

### Phase 5: Agent Runtime Core

Objective: implement the runtime behavior common to Analyzer, Executor, and Evaluator.

Steps:

1. Implement the harness state machine.
2. Implement context assembly and truncation rules.
3. Implement structured step tracing for ReAct execution.
4. Implement instruction hierarchy enforcement.
5. Implement model routing by agent role.
6. Implement approval request flow and policy denial handling.
7. Implement budget tracking and compaction triggers.
8. Add tests for context shaping and action validation.

Exit criteria:

- Agent calls receive bounded, role-specific context.
- Step traces are persisted.
- ReAct actions cannot bypass typed tool calls.
- Policy-denied actions produce structured failures.
- Harness state transitions are durable and valid.

### Phase 6: Analyzer Agent

Objective: produce safe, structured plans.

Steps:

1. Implement analyzer prompt builder.
2. Implement analyzer response parser.
3. Add risk classification.
4. Add success criteria generation.
5. Add required tool extraction.
6. Add tests for valid and invalid model outputs.

Exit criteria:

- `little-helper plan "TASK"` returns an `AnalysisResult`.
- The plan command has no side effects.
- Risky actions are marked for approval.

### Phase 7: Tool Layer

Objective: provide controlled external effects.

Steps:

1. Implement base tool protocol.
2. Implement tool registry.
3. Implement filesystem read/list/write with root enforcement.
4. Implement shell command execution with allowlist.
5. Implement PTY/process session handling.
6. Implement git read tools and patch/diff tooling.
7. Implement tool call logging.
8. Implement output truncation.
9. Implement secret redaction.

Exit criteria:

- Tools cannot access paths outside allowed roots.
- Denied tools return policy errors.
- Tool records are written to artifacts.

### Phase 8: MCP Integration

Objective: support external tool and resource servers through MCP.

Steps:

1. Implement typed MCP server config.
2. Implement MCP client lifecycle management.
3. Discover tools and resources from configured servers.
4. Normalize MCP tools into the local tool registry.
5. Apply permissions, timeouts, and provenance tagging.
6. Add integration tests with a mock MCP server.

Exit criteria:

- MCP tools appear in `tools list`.
- MCP resource reads are logged and tagged by source.
- MCP tool calls follow the same policy path as built-in tools.

### Phase 9: Executor Agent

Objective: execute analyzer plans through the tool layer.

Steps:

1. Implement executor prompt builder.
2. Implement step-by-step execution.
3. Map plan steps to tool calls.
4. Stop on blockers.
5. Track changed files.
6. Support sub-agent delegation where configured.
7. Write execution report.

Exit criteria:

- Executor never bypasses tools.
- Failed tool calls appear in the execution report.
- Changed files and artifacts are recorded.

### Phase 10: Evaluator Agent

Objective: independently verify completion.

Steps:

1. Implement evaluator prompt builder.
2. Compare results to success criteria.
3. Run configured validation commands through policy.
4. Return pass, fail, or needs-revision.
5. Add production readiness checks.
6. Write evaluation report.

Exit criteria:

- Runs only pass when success criteria are satisfied.
- Missing validation produces an explicit risk note.
- Revision instructions are actionable.

### Phase 11: Full Orchestration

Objective: connect analyzer, executor, and evaluator.

Steps:

1. Implement run lifecycle.
2. Implement bounded revision loop.
3. Persist state after each phase.
4. Add checkpointing and recovery flow.
5. Support dry-run.
6. Support resume.
7. Add integration tests with mocked agents.

Exit criteria:

- `little-helper run "TASK"` completes a full loop.
- Max iterations are enforced.
- Resume works without repeating completed steps unsafely.
- Recovery can reconcile interrupted runs safely.

### Phase 12: Production Hardening

Objective: make the product deployable and operable.

Steps:

1. Add Dockerfile.
2. Add production config validation.
3. Add JSON logging.
4. Add metrics hooks.
5. Add rate limit handling.
6. Add security scans.
7. Add lease and heartbeat handling for long-running runs.
8. Add CI pipeline.
9. Add deployment documentation.
10. Add operational budgets and cost reporting.

Exit criteria:

- Docker image builds reproducibly.
- CI runs lint, type check, tests, and security checks.
- Production config cannot start with unsafe defaults.
- Operators can diagnose failed runs from logs and artifacts.

## 16. Production Deployment

### 16.1 Dockerfile Requirements

The Docker image must:

- Use a slim, pinned Node.js base image.
- Enable Corepack and install dependencies with `pnpm --frozen-lockfile`.
- Build TypeScript during the image build.
- Install only production runtime dependencies in the final stage.
- Run as a non-root user.
- Set a working directory.
- Expose no ports unless needed.
- Use `node dist/cli.js` as the entrypoint.

### 16.2 Runtime Environment

Production runtime must provide:

- Required environment variables.
- Secret injection through platform secret manager.
- Persistent artifact volume or external object storage.
- Log collection.
- Resource limits.
- Network policy.

### 16.3 Release Checklist

Before releasing:

- All tests pass.
- Type checks pass.
- Lint checks pass.
- Docker image builds.
- Dependency audit passes or accepted risks are documented.
- `.env.example` is current.
- `README.md` includes installation and usage.
- `docs/deployment.md` includes production deployment steps.
- `docs/operations.md` includes troubleshooting.

## 17. CI/CD Pipeline

Minimum CI stages:

```text
install
lint
typecheck
test
security-scan
build-image
smoke-test-image
```

Recommended commands:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js doctor --output json
docker build -t little-helper-agent .
docker run --rm little-helper-agent version
```

Deployment should be manual at first, then automated after the release process is stable.

## 18. Acceptance Criteria

The product is production-ready when all criteria below are true:

- CLI commands are stable and documented.
- Analyzer, executor, and evaluator are separate components.
- The executor uses a bounded ReAct loop through typed actions.
- Agent boundaries use typed structured data.
- Tool access is mediated by policy.
- MCP integration follows the same permission and audit path as built-in tools.
- Context compaction and resume behavior are defined and implemented.
- Interactive PTY/session handling is controlled and auditable.
- Git and diff awareness prevent clobbering unrelated changes.
- Harness state, checkpoints, and recovery flow are implemented.
- Long-running runs use leases, heartbeats, or equivalent liveness controls.
- Runs are persisted and inspectable.
- Errors have stable codes and clear messages.
- Tests cover the orchestration loop.
- Secrets are not logged or written to artifacts.
- Production config rejects unsafe defaults.
- Docker deployment works.
- Operators can inspect status, logs, and artifacts.
- The evaluator can fail incomplete work and trigger revisions.
- The system stops safely when blocked.

## 19. First Milestone Implementation Checklist

Use this as the first sprint checklist:

```text
[ ] Create TypeScript package skeleton
[ ] Add CLI framework
[ ] Add version command
[ ] Add Zod schemas and inferred TypeScript types
[ ] Add settings loader
[ ] Add run ID generator
[ ] Add artifact store
[ ] Add mock LLM client
[ ] Add context assembly and step trace support
[ ] Add budget tracking and compaction support
[ ] Add analyzer with structured output
[ ] Add plan command
[ ] Add tests for models, config, and plan command
```

## 20. Second Milestone Implementation Checklist

Use this as the second sprint checklist:

```text
[ ] Add tool registry
[ ] Add patch/diff edit tool
[ ] Add filesystem tool
[ ] Add shell tool with allowlist
[ ] Add PTY/process session tool
[ ] Add git status and diff read tools
[ ] Add MCP client and mock MCP server tests
[ ] Add policy engine
[ ] Add executor agent
[ ] Add execution report
[ ] Add evaluator agent
[ ] Add run command
[ ] Add integration tests for full mocked workflow
```

## 21. Third Milestone Implementation Checklist

Use this as the production hardening checklist:

```text
[ ] Add resume command
[ ] Add status command
[ ] Add logs command
[ ] Add artifacts command
[ ] Add doctor command
[ ] Add JSON logging
[ ] Add Dockerfile
[ ] Add CI pipeline
[ ] Add security scanning
[ ] Add deployment docs
[ ] Add operations docs
[ ] Run full release checklist
```

## 22. Final Product Definition

The final production version is a CLI application that can be installed, configured, and executed in a controlled environment. A user can run:

```text
little-helper run "Implement the requested task"
```

The product will:

1. Analyze the task.
2. Create a structured plan.
3. Execute approved steps through safe tools.
4. Evaluate the result against explicit criteria.
5. Revise when needed.
6. Produce inspectable artifacts.
7. Exit with a reliable status code.

The system is considered complete only when it is safe to operate repeatedly in production, not merely when it works once in a local demo.
