# Argus Architecture

## 1. Purpose And Current Scope

Argus is a TypeScript, CLI-first agent runtime that plans work with an analyzer agent, executes it through a typed tool layer, and verifies it with an evaluator agent. The same runtime is exposed through four product surfaces:

- CLI commands in `src/cli.ts`
- interactive chat sessions in `argus chat` via `src/chat/*`
- a headless multi-tenant API and SSE stream layer via `src/service/*` and `src/server/app.ts`
- a small TypeScript SDK in `packages/sdk/src/index.ts`

The current implementation is not a blank-slate blueprint anymore. It already includes resumable runs, approval gating, context compaction, token-usage tracking, MCP tool discovery, skill selection, terminal session supervision, a headless worker queue, and persisted run artifacts.

## 2. Runtime Surfaces

### 2.1 CLI

`src/cli.ts` is the operator entrypoint. It loads settings, constructs the orchestrator, streams progress, and renders results. The implemented commands are:

- `argus run <task>`
- `argus plan <task>`
- `argus eval <runId>`
- `argus status <runId>`
- `argus logs <runId>`
- `argus artifacts <runId>`
- `argus diff <runId>`
- `argus review <runId>`
- `argus resume <runId>`
- `argus cancel <runId>`
- `argus doctor`
- `argus config validate`
- `argus tools list`
- `argus mcp list|inspect|add|validate`
- `argus skills add|list|inspect|validate`
- `argus approvals <runId>`
- `argus sessions <runId>`
- `argus checkpoints <runId>`
- `argus recover <runId>`
- `argus chat`

### 2.2 Interactive Chat

`src/chat/interactive.ts` wraps the normal orchestration flow in a TTY session model. Each user turn becomes a normal `RunRequest`, but the request also carries `conversationContext`, optional `editorContext`, operator-mode metadata, and the selected provider/model from `src/chat/session-manager.ts`. Chat sessions persist under `.little-helper/runs/chat/<sessionId>/`.

The chat layer supports:

- `suggest`, `auto-edit`, and `full-auto` operator modes
- session resume and new-session creation
- slash commands for approvals, MCP, skills, and runtime inspection
- persisting assistant summaries and recent activity for context compaction
- live LLM and tool streaming through the same renderer used by the CLI

### 2.3 Headless API And Worker Runtime

The headless surface is built from:

- `src/service/platform.ts` for dependency wiring
- `src/service/session-service.ts` for session CRUD
- `src/service/run-service.ts` for queued run creation
- `src/service/approval-service.ts` for approval decisions and resume scheduling
- `src/service/stream-service.ts` for persisted event replay plus live subscriptions
- `src/service/worker.ts` for leasing and executing queued jobs
- `src/server/app.ts` for the HTTP and SSE API

The API currently exposes:

- `GET /v1/health`
- `POST /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `GET|POST /v1/sessions/:sessionId/messages`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/approvals`
- `POST /v1/approvals/:approvalId/decision`
- `GET /v1/runs/:runId/stream`

Authentication is bearer-token based and delegates to the configured API-key repository.

Headless message creates can also carry a normalized `editorContext` payload with:

- workspace id
- active file
- selection and visible ranges
- open files and recent files
- optional diagnostics
- optional retrieval settings for workspace expansion

### 2.4 SDK

`packages/sdk/src/index.ts` provides `ArgusClient`, a thin HTTP client for the headless API. It supports session creation, sending messages, polling runs, approving/denying approvals, consuming the SSE stream, selecting provider/model per session or per message, and forwarding normalized `editorContext` payloads from IDE or external clients.

## 3. Boot And Configuration Flow

Configuration is assembled by `src/config.ts` and validated by `SettingsSchema` in `src/schemas.ts`.

Load order is:

1. defaults
2. project config at `.little-helper.config.json`
3. user config at `~/.config/little-helper/config.json`
4. workspace `.env` and process env via `src/env.ts`
5. CLI overrides

Important settings include:

- artifact storage root
- approval mode
- shell allowlist
- network allowlist
- validation commands
- allowed filesystem roots
- skill directories
- MCP servers
- global and per-role LLM routing
- compaction threshold and tool-output truncation limits

Production validation currently enforces:

- the provider-specific API key required by each resolved analyzer/executor/evaluator route when `env=production`
- streaming when `approvalMode=always`

## 4. High-Level Control Flow

The normal `argus run` path is:

```text
CLI
  -> loadSettings()
  -> Orchestrator.run()
  -> RunStore + ArtifactStore init
  -> ToolRegistry.create()
  -> createLLMClient()
  -> discoverSkillCatalog() + selectSkills()
  -> HarnessController.run()
  -> AnalyzerAgent
  -> ExecutorAgent
  -> Approval wait or EvaluatorAgent
  -> Finalizer.writeFinalReport()
  -> CLI renderer prints terminal summary
```

`src/orchestrator.ts` is intentionally thin. It resolves dependencies and hands control to `src/harness/controller.ts`, which owns the lifecycle.

## 5. Core Modules

### 5.1 Agents

`src/agents/base.ts` defines the shared runtime context. Each agent receives:

- run metadata and working directory
- settings and policy
- tool registry
- artifact store
- token budget state
- step trace
- approval manager state
- optional context snapshot
- optional LLM event callback

`AnalyzerAgent` in `src/agents/analyzer.ts`:

- enumerates available tools
- builds a protected prompt envelope
- runs prompt preflight and compaction
- requests a structured `AnalysisResult`
- records prompt and token-usage artifacts

`ExecutorAgent` in `src/agents/executor.ts`:

- consumes the ordered plan from analysis
- maintains per-step memory in `ExecutorStepMemory`
- asks the executor model for one typed `ExecutorAction` at a time
- validates chosen tools against the step allowlist
- falls back to deterministic tool input construction when the model omits fields
- supports `tool_call`, `patch_proposal`, `final_response`, `clarification`, and `handoff_to_evaluator`
- records step trace, tool calls, changed files, transcripts, and blockers

`EvaluatorAgent` in `src/agents/evaluator.ts`:

- checks each success criterion
- folds executor blockers into failed criteria
- resolves validation commands from settings or workspace auto-detection
- runs validation through `validation.run`
- returns `pass` or `needs_revision` with structured reasons

### 5.2 Harness

The harness is implemented in `src/harness/*`:

- `controller.ts`: main run loop and phase dispatch
- `state-machine.ts`: legal status transitions
- `checkpoint-manager.ts`: durable checkpoint writes
- `scheduler.ts`: evaluation-to-next-state decisions
- `lease-manager.ts`: run lease ownership and heartbeat timestamps
- `approvals.ts`: persisted approval state
- `budget-manager.ts`: budget enforcement
- `session-supervisor.ts`: persisted shell-session reconciliation
- `recovery.ts`: restart-safe run reconstruction
- `finalizer.ts`: final report and combined diff generation

The implemented harness states are:

- `created`
- `planning`
- `awaiting_approval`
- `executing`
- `evaluating`
- `revising`
- `paused`
- `blocked`
- `completed`
- `failed`
- `cancelled`

The controller persists state before and after each major phase and writes checkpoints after meaningful transitions.

### 5.3 Context Management

`src/context/manager.ts` builds `AgentContextSnapshot` objects from:

- user task and instruction hierarchy
- upstream editor context from the run request
- chat context
- selected skills
- current run state
- prior analysis, execution, and evaluation output
- approvals
- revision history
- step trace

Editor-driven expansion now lives entirely under `src/context/*`:

- `editor-context.ts`: normalizes active-file, selection, visible-range, open-file, recent-file, and diagnostic payloads; extracts trusted editor focus and local code neighborhood sections
- `retrieval-index.ts`: maintains a local incremental workspace index under `.little-helper/runs/editor-index/*.json`
- `ranking.ts`: keeps direct selection/current-file context ahead of broader retrieval and deduplicates retrieved chunks

The current prompt-oriented section order is:

1. user task
2. editor focus
3. local code neighborhood
4. chat context, selected skills, and run state
5. retrieved workspace context
6. prior analysis, execution, evaluation, approvals, revisions, and step trace

Trust semantics are explicit:

- active file, explicit selection, visible ranges, and diagnostics from the host are `trusted`
- retrieved workspace chunks and prior model outputs remain `untrusted_context`

Retrieval is only pre-prompt workspace expansion. It does not replace runtime tool use; analyzer, executor, and evaluator still rely on the built-in filesystem and search tools for grounded follow-up work.

Each section is tagged as either `trusted` or `untrusted_context`. The snapshot is rendered in `full`, `compact`, or `aggressive` modes, persisted to `context-summary.md`, `context-sources.json`, and `context-snapshot.json`, and reused by prompt-preflight compaction.

### 5.4 LLM Layer

The LLM stack lives in `src/llm/*`:

- `client.ts`: provider-neutral interfaces
- `providers.ts`: role-based client routing
- `routing.ts`: resolves analyzer/executor/evaluator model settings
- `capabilities.ts`: validated provider/model support matrix and built-in context windows
- `openai.ts`: OpenAI Responses API implementation
- `anthropic.ts`: Anthropic Messages API implementation
- `gemini.ts`: Gemini native structured-output implementation
- `moonshot.ts`: Moonshot native structured-output implementation
- `json-schema.ts`: Zod-to-JSON-schema conversion
- `prompts.ts`: protected prompt-envelope assembly
- `usage-tracker.ts`: token snapshots and telemetry

Current provider status:

- native adapters are implemented for `openai`, `anthropic`, `gemini`, and `moonshot`
- provider selection is available from CLI overrides, chat session state, headless session/message inputs, and SDK request types
- strict structured-output support is mandatory; unsupported provider/model combinations fail fast during client construction
- built-in context-window defaults cover the validated provider model families and can be overridden with `llmContextWindows`

Prompt handling is designed around prompt attestation, not loose string concatenation. Each agent prompt produces:

- a core prompt reference
- a policy overlay reference
- visible append text
- structured context payload
- attestation hashes

Prompt bodies are not persisted as public artifacts. Prompt metadata and hashes are.

## 6. Tool System

### 6.1 Registry And Categories

`src/tools/registry.ts` registers all built-ins and normalizes MCP tools into the same invocation path. Current built-in tools are:

- `fs.read`
- `fs.list`
- `fs.write`
- `fs.patch`
- `fs.search`
- `fs.diff`
- `git.inspect`
- `shell.exec`
- `validation.run`
- `web.fetch`
- `web.search`

Tool categories are enforced through `ToolDescriptor` metadata:

- `read`
- `edit`
- `execution`
- `search`
- `network`
- `mcp`
- `validation`

### 6.2 Filesystem Tools

`src/tools/filesystem.ts` provides bounded workspace access:

- path validation through `PermissionPolicy.ensurePathAllowed`
- safe writes only inside allowed roots
- simple backup and diff artifacts on mutation
- lightweight git-awareness before writes so unrelated tracked edits are not silently overwritten
- recursive listing and naive text search for context gathering

### 6.3 Shell And Validation Tools

`src/tools/shell.ts` provides allowlisted command execution only. Key behaviors:

- command allowlist enforcement
- timeout handling
- cancellation via abort signal
- persisted `sessions.json` entries for one-shot and PTY-like sessions
- stdout and stderr truncation
- secret redaction

`validation.run` reuses the shell implementation but is classified as validation work and is not treated as a user-directed mutation path.

### 6.4 Web Tools

`src/tools/web.ts` currently supports:

- `web.fetch` for allowlisted HTTP GET
- `web.search` backed by the Perplexity Search API

Both remain subject to the network allowlist and approval workflow. `web.search` requires `PERPLEXITY_API_KEY`.

### 6.5 MCP Integration

`src/mcp/client.ts` and `src/mcp/config-manager.ts` implement Argus's MCP layer. The current behavior is:

- project and user config merge for `mcpServers`
- discovery of tools, resources, and resource templates
- registration of discovered tools as `mcp.<server>.<tool>`
- allow-tool filtering per server
- stdio and HTTP transport support
- SSE transport explicitly not implemented yet

Every discovered MCP tool still passes through the same policy engine as built-in tools.

## 7. Policy, Safety, And Approvals

`src/policy/permissions.ts` is the central policy engine. It decides `allow`, `deny`, or `require_approval` from:

- tool descriptor metadata
- risk level
- approval mode
- operator mode
- approval history for the same tool and input digest
- shell allowlist and network allowlist

Notable rules in the current build:

- side effects and high-risk actions are blocked or approval-gated based on `approvalMode`
- `suggest` mode requires approval for edits and shell commands
- `auto-edit` still requires approval for shell commands
- non-allowlisted network targets require approval unless already approved

Approval records are stored both in run artifacts and, for the headless API, in the approval repository. The same approval decision is used for CLI resume, chat resume, and headless queued resume.

`src/policy/safety.ts` provides command risk classification and secret redaction.

## 8. Persistence Model

### 8.1 Run Artifacts

Every run lives under `.little-helper/runs/<runId>/`. Common artifacts include:

- `request.json`
- `analysis.json`
- `execution.json`
- `evaluation.json`
- `tool-calls.json`
- `step-trace.jsonl`
- `budget.json`
- `harness-state.json`
- `approvals.json`
- `sessions.json`
- `revisions.json`
- `context-summary.md`
- `context-sources.json`
- `context-snapshot.json`
- `token-usage.json`
- `final-report.md`
- `prompt-envelope-*.json`
- `checkpoints/*.json`
- `artifacts/*.json`
- `artifacts/*.patch`

`src/memory/artifact-store.ts` also supports confidentiality modes so metadata can be written without persisting full sensitive payloads.

The local retrieval index is persisted separately from per-run artifacts under:

- `.little-helper/runs/editor-index/*.json`

### 8.2 Stores And Repositories

Local filesystem-backed run persistence is handled by:

- `RunStore`
- `ArtifactStore`
- `SessionStore`

Headless multi-tenant persistence is abstracted behind repository interfaces in `src/repositories/base.ts`. The repo includes an in-memory implementation in `src/repositories/in-memory.ts`, which is used by tests and by any embedding host that does not yet supply a database-backed bundle.

## 9. Session, Resume, And Recovery Semantics

Resume logic is split across the harness and the headless worker:

- `HarnessController.resume()` reconstructs the run from artifacts
- `RecoveryManager` reloads state, analysis, execution, evaluation, revisions, budget, and terminal sessions
- `SessionSupervisor` reconciles stale running-process records
- `ApprovalService` queues resume jobs after the last pending approval is approved

This means Argus can survive:

- process restarts between phases
- approval wait states
- stale persisted shell sessions
- user-driven resume from CLI or API

The current implementation does not yet include multi-process distributed coordination beyond job leasing in the headless worker.

## 10. Headless Data Model

The headless layer uses typed records from `src/schemas.ts`:

- `HeadlessSessionRecord`
- `HeadlessMessageRecord`
- `HeadlessRunRecord`
- `HeadlessApprovalRecord`
- `HeadlessEvent`
- `HeadlessJob`
- `TenantRecord`
- `ApiKeyRecord`

Run execution in the headless mode is queue-based:

1. create session
2. post user message
3. create queued run record
4. enqueue an `execute` job
5. worker leases and runs the orchestrator
6. worker persists approvals and assistant reply
7. stream service replays and pushes SSE events
8. approval decisions may enqueue a `resume` job

Headless session and message inputs can persist provider/model selection. The selected pair is copied into chat session state, written into the run request metadata, and reused by worker resume so queued execution stays deterministic even if process-level defaults change later.

Headless message inputs can also persist `editorContext`. The normalized payload is copied into `request.json`, used during context assembly, and reused unchanged during queued resume.

## 11. Schema And Type Contracts

`src/schemas.ts` is the contract backbone of the system. It defines runtime and compile-time types for:

- run requests and plans
- execution and evaluation reports
- executor actions and step memory
- terminal session state
- harness state and checkpoints
- prompt envelopes and context snapshots
- telemetry and token usage
- chat state
- headless API records
- settings and MCP server definitions
- skill manifests and selected-skill reasons

Argus expects all control-plane boundaries to pass through these schemas before use.

## 12. Skills

`src/skills/registry.ts` adds task-conditioned skill selection on top of the run request. The current implementation:

- resolves project and user skill directories
- validates `SKILL.md` and manifest metadata
- selects up to three best-matching skills
- records why each skill was selected
- persists the chosen skills to `selected-skills.json`

Skills affect prompt context and planning, but they do not bypass permissions, tool policy, or schema validation.

## 13. Telemetry And Rendering

`src/telemetry/events.ts` and `src/telemetry/metrics.ts` generate structured run events and metrics. CLI and chat rendering are intentionally separate from orchestration:

- `src/rendering/runtime-output.ts` streams progress
- `src/rendering/run-result.ts` formats terminal summaries
- `src/rendering/approvals.ts` formats approval views

The headless service persists events for replay and SSE fan-out. CLI rendering is ephemeral; the audit trail lives in artifacts and headless event repositories.

## 14. Security And Operational Boundaries

Current safety boundaries are:

- workspace filesystem roots are allowlisted
- shell commands are executable-name allowlisted
- network targets are host allowlisted or approval-gated
- side effects must go through registered tools
- prompts and tool outputs are schema-validated
- secrets are redacted from shell output summaries
- prompt bodies are not persisted as public artifacts

Important current limitations:

- only `openai`, `anthropic`, `gemini`, and `moonshot` are implemented; any other provider remains unsupported
- MCP SSE transport is not implemented
- there is no built-in standalone `argus serve` CLI command yet
- evaluator criteria checks are partly heuristic unless backed by explicit validation commands
- filesystem search and diff utilities are intentionally simple

## 15. Testing And Change Safety

The repository currently covers the runtime with unit, integration, and e2e tests under `tests/`:

- unit coverage for schemas, tools, config, rendering, chat sessions, approvals, evaluator logic, executor logic, MCP config, and session supervision
- integration coverage for orchestrator flow, chat CLI, MCP behavior, headless API, and SDK usage
- e2e CLI smoke coverage

The package scripts that define the supported engineering workflow are:

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test`
- `pnpm dev -- <command>`

## 16. Source-Of-Truth Summary

When you need to understand how Argus works, the source of truth is:

1. `src/schemas.ts` for contracts
2. `src/cli.ts` for exposed user interfaces
3. `src/orchestrator.ts` plus `src/harness/*` for lifecycle control
4. `src/agents/*` for planning, execution, and evaluation behavior
5. `src/tools/*`, `src/policy/*`, and `src/mcp/*` for all side effects
6. `src/chat/*`, `src/service/*`, `src/server/app.ts`, and `packages/sdk/src/index.ts` for non-CLI integration surfaces

This document should be updated whenever those areas change materially. `AGENTS.MD` must stay aligned with it.
