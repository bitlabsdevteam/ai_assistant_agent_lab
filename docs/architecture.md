# Architecture

The runtime is split into four layers:

1. CLI rendering in `src/cli.ts`.
2. Orchestration and harness control in `src/orchestrator.ts` and `src/harness/*`.
3. Agent logic in `src/agents/*`.
4. Tool, policy, memory, and telemetry infrastructure in their dedicated modules.

Each run persists artifacts under `.little-helper/runs/RUN_ID/`, including request, analysis, execution, evaluation, events, checkpoints, approvals, sessions, final report files, and MCP tool-call artifacts with provenance.

Context assembly is handled by `src/context/manager.ts`. It builds role-specific summaries from the request, run state, prior agent outputs, approvals, and recent step traces, then compacts oversized summaries into resumable artifacts.

Evaluation is handled by `src/agents/evaluator.ts`. Validation is now selected explicitly per run: configured commands take priority, otherwise the evaluator auto-detects supported workspace validation and records structured `validationDecisions` in `evaluation.json` for audit and replay.

Session supervision is handled by `src/harness/session-supervisor.ts` together with `sessions.json`. The supervisor refreshes persisted running sessions against local PIDs, records terminal reasons such as `operator_cancelled` or `stale_on_recovery`, and is used by both recovery and the `argus sessions` CLI controls.

LLM routing lives behind `src/llm/client.ts` and `src/llm/providers.ts`. The current build targets the OpenAI Responses API and validates structured JSON-schema output derived from the runtime's Zod contracts.

The runtime now resolves provider settings per role. Global `llmProvider` and `llmModel` act as defaults, while `settings.llmRouting.analyzer`, `settings.llmRouting.executor`, and `settings.llmRouting.evaluator` can override provider, model, base URL, organization, and project independently.

Execution is no longer purely hardcoded per task pattern. `src/agents/executor.ts` now requests a structured executor action for each step, validates that the chosen action stays within the step's allowed tools, and then executes through the existing policy-gated tool registry. Deterministic input construction remains as a fallback when the model omits tool arguments, which keeps basic workflows stable while still using model-guided action selection.
