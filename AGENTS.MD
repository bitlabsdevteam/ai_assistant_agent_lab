# Argus Implementation Guide

This file is the contributor-level guide for Argus as it exists today. It is not a greenfield wish list. The canonical system description is [docs/architecture.md](docs/architecture.md), and this file must stay consistent with it.

## 1. Product Definition

Argus is a TypeScript multi-agent runtime with four shipped surfaces:

- CLI orchestration in `src/cli.ts`
- interactive chat in `src/chat/*`
- headless API plus background worker in `src/service/*` and `src/server/app.ts`
- a TypeScript SDK in `packages/sdk/src/index.ts`

Its core runtime still centers on three primary agents:

- Analyzer Agent: plans the task and defines success criteria
- Executor Agent: performs approved tool actions step by step
- Evaluator Agent: verifies the result and requests revisions when needed

## 2. Current Repository Shape

The repository structure that contributors should preserve is:

```text
argus/
  AGENTS.MD
  README.md
  package.json
  tsconfig.json
  tsup.config.ts
  eslint.config.js
  prettier.config.js
  Dockerfile
  docker-compose.yml
  docs/
    architecture.md
    deployment.md
    operations.md
    customer-install-and-integration.md
  src/
    cli.ts
    config.ts
    env.ts
    errors.ts
    index.ts
    logger.ts
    schemas.ts
    orchestrator.ts
    agents/
    chat/
    commands/
    context/
    harness/
    llm/
    mcp/
    memory/
    policy/
    rendering/
    repositories/
    server/
    service/
    skills/
    telemetry/
    tools/
  packages/
    sdk/
  tests/
    unit/
    integration/
    e2e/
```

Do not remove or rename shipped subsystem directories without updating `docs/architecture.md`, `README.md`, and this file together.

## 3. Core Architecture Rules

These rules describe the implemented Argus runtime and should guide all changes:

- All control-plane contracts live in `src/schemas.ts` and must be Zod-validated.
- The CLI, chat runtime, and headless API all use the same `Orchestrator` and harness.
- All side effects must go through the typed tool layer in `src/tools/*` or normalized MCP tool calls from `src/mcp/*`.
- The policy engine in `src/policy/permissions.ts` is mandatory for filesystem, shell, network, and MCP actions.
- Prompt assembly must stay behind `src/llm/prompts.ts`; do not scatter agent prompt text across the codebase.
- Prompt preflight, token counting, and compaction must remain wired through the LLM layer.
- Run state must remain resumable from persisted artifacts under `.little-helper/runs/<runId>/`.
- Approval wait states are durable state transitions, not transient console prompts.
- Chat state and headless records are separate from run artifacts but must remain schema-aligned.

## 4. Current Runtime Behavior

### 4.1 Orchestration

`src/orchestrator.ts` wires settings, tools, LLM routing, policy, skill selection, and the harness controller.

`src/harness/controller.ts` owns the lifecycle:

- create run and artifact directories
- persist request and selected skills
- acquire run lease
- run analyzer
- run executor
- stop for approvals or continue to evaluator
- revise or finalize based on evaluator status
- checkpoint state after major transitions

Valid harness states are:

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

### 4.2 Agents

The analyzer, executor, and evaluator live in `src/agents/*`.

Implementation expectations:

- analyzer returns a typed `AnalysisResult`
- executor selects one typed `ExecutorAction` at a time
- executor records tool calls, transcripts, changed files, produced artifacts, blockers, and step trace
- evaluator returns a typed `EvaluationResult`
- evaluator runs configured or auto-detected validation through `validation.run`

### 4.3 Context And Compaction

`src/context/manager.ts` must remain the single place that assembles context snapshots and source references. If you add new evidence sources, add them there and document them in `docs/architecture.md`.

Current upstream editor-context behavior:

- `RunRequest` may carry normalized `editorContext` for IDE or headless callers
- `src/context/editor-context.ts` extracts trusted active-file and selection state
- `src/context/retrieval-index.ts` maintains a local incremental workspace index under `.little-helper/runs/editor-index/*`
- `src/context/ranking.ts` keeps direct editor focus ahead of broader retrieved context
- active file, explicit selection, visible ranges, and diagnostics from the host are `trusted`
- retrieved workspace chunks remain `untrusted_context`

### 4.4 Tools And Policy

The shipped built-in tool names are:

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

If you add or remove a built-in tool:

1. update `src/tools/registry.ts`
2. update the relevant schemas or descriptors
3. update `docs/architecture.md`
4. update this file if the tool changes the architecture or safety model

### 4.5 LLM Routing

The current provider implementation includes native `openai`, `anthropic`, `gemini`, and `moonshot` adapters behind the shared `LLMClient` contract. Global settings provide defaults, `settings.llmRouting.analyzer|executor|evaluator` can override each role independently, and per-run or per-session provider/model selections are persisted in request or session state for deterministic resume.

If you add another provider:

- keep provider specifics behind `src/llm/*`
- do not leak provider-specific logic into agents or the harness
- keep strict structured-output validation mandatory; do not add prose-parsing fallback
- update `docs/architecture.md`, `README.md`, and this file

### 4.6 MCP

Argus currently supports MCP discovery over:

- `stdio`
- `http`

`sse` is declared in schemas but not implemented in `src/mcp/client.ts`. Do not document it as functional unless that code exists.

### 4.7 Chat And Headless Runtime

Chat sessions in `src/chat/*` and headless records in `src/service/*` are real product surfaces, not experiments. Any architecture change that affects run status, approvals, assistant replies, event streams, or session state must consider:

- CLI behavior
- chat behavior
- headless API behavior
- SDK compatibility

Headless messages and chat-prepared turns now also support a shared `editorContext` payload so IDE or external clients can pass active-file, selection, visible-range, open-file, recent-file, and diagnostic state into the run request directly.

## 5. Data And Artifact Expectations

Argus persists run artifacts under `.little-helper/runs/<runId>/`. Contributors should expect and preserve files such as:

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
- `context-summary.md`
- `context-sources.json`
- `context-snapshot.json`
- `token-usage.json`
- `final-report.md`
- `checkpoints/*`
- `artifacts/*`

Argus also persists the shared local retrieval index outside individual runs under:

- `.little-helper/runs/editor-index/*`

If a change adds, removes, or changes a first-class artifact, document it in `docs/architecture.md`.

## 6. Safety Rules

Do not weaken these guarantees without deliberate architectural work:

- filesystem writes must remain inside `allowedRoots`
- shell commands must remain allowlisted
- network access must remain allowlisted or approval-gated
- approvals must remain durable and replayable
- schema validation must occur before trusting model or tool outputs
- prompt metadata may be persisted, but prompt bodies must not become public artifacts by accident

## 7. Package And Runtime Workflow

Current scripts from `package.json` are the supported workflow:

```json
{
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
```

The executable is exposed as:

```json
{
  "bin": {
    "argus": "./dist/cli.js"
  }
}
```

## 8. Documentation Maintenance Rule

When the architecture changes materially, update all of the following in the same change when applicable:

1. `docs/architecture.md`
2. `AGENTS.MD`
3. `README.md`
4. affected schemas, commands, or code comments

At minimum, changes to any of these areas require a documentation review:

- new CLI commands
- new tool categories or built-in tools
- new artifact files
- new harness states or resume behavior
- new headless API endpoints
- new provider support
- MCP transport changes
- chat session model changes
- approval model changes

## 9. Current Gaps And Non-Goals

Be precise about what Argus does not yet provide:

- no built-in `argus serve` command
- no provider implementation outside `openai`, `anthropic`, `gemini`, and `moonshot`
- no implemented MCP SSE transport
- no database-backed repository bundle in this repo
- evaluator success checks are only as strong as the configured or auto-detected validation

Do not write docs that imply those features already exist.
