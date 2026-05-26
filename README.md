# ai_assistant_agent_lab

# Argus

`Argus` is a CLI-first multi-agent runtime with separate analyzer, executor, and evaluator agents, durable run artifacts, policy-gated tool execution, and resumable harness state.

## Customer Readiness

Customers can use `Argus` today if they are comfortable self-hosting a Node.js CLI or service and supplying OpenAI credentials. The most production-ready entry point is the CLI, Docker packaging exists for deployment, and the repository also exposes a tested SDK plus headless HTTP/SSE runtime for embedding.

One important constraint: there is no first-class `argus serve` command yet. API deployment is possible, but it currently requires a small custom Node host that wraps the exported runtime objects.

For the full customer-engineer path, see [docs/customer-install-and-integration.md](docs/customer-install-and-integration.md).

## Requirements

- Node.js 22+
- `pnpm` 9+

## Install

```bash
pnpm install
pnpm build
```

## LLM Providers

The runtime uses the OpenAI Responses API with structured JSON output validated against the runtime's Zod schemas.

Minimal OpenAI configuration:

```bash
export LITTLE_HELPER_LLM_PROVIDER=openai
export LITTLE_HELPER_LLM_MODEL=gpt-5.4
export OPENAI_API_KEY=...
```

Perplexity-backed web search tool configuration:

```bash
export PERPLEXITY_API_KEY=...
```

Optional settings:

- `LITTLE_HELPER_LLM_BASE_URL`
- `LITTLE_HELPER_LLM_ORGANIZATION`
- `LITTLE_HELPER_LLM_PROJECT`

To allow the built-in `web.search` tool, add `api.perplexity.ai` to `networkAllowlist`.

`argus doctor` now checks configured OpenAI reachability with the selected model when `llmProvider=openai`.

Role-specific routing can be configured in `.little-helper.config.json`:

```json
{
  "llmProvider": "openai",
  "llmModel": "gpt-5.4",
  "llmRouting": {
    "analyzer": {
      "provider": "openai",
      "model": "gpt-5.4"
    },
    "evaluator": {
      "provider": "openai",
      "model": "gpt-5.4-mini"
    }
  }
}
```

Global LLM settings act as defaults. `llmRouting` overrides only the specified role fields for `analyzer`, `executor`, or `evaluator`.

## Execution Model

The executor now uses a typed action-selection loop per plan step:

- the executor asks the configured executor model for one structured action
- the action must be `tool_call`, `final_response`, or `clarification`
- tool calls are still validated against the step's allowed tools and policy layer
- model-supplied tool inputs can override defaults, but the runtime falls back to deterministic input construction when fields are omitted

This keeps side effects inside the typed tool layer while moving execution closer to the ReAct-style runtime described in `AGENTS.MD`.

## Usage

```bash
pnpm dev -- version
pnpm dev -- doctor
pnpm dev -- plan "Create a health endpoint"
pnpm dev -- run "Create a health endpoint"
```

## Local And Docker Test Workflow

Use two separate test paths depending on what you need to verify.

For repository health without a live model:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

For a real agent run with OpenAI:

```bash
export LITTLE_HELPER_LLM_PROVIDER=openai
export LITTLE_HELPER_LLM_MODEL=gpt-5.4
export OPENAI_API_KEY=...

pnpm dev -- doctor
pnpm dev -- plan "Create a health endpoint"
pnpm dev -- run "Create a health endpoint"
```

The same live checks also work from the built CLI:

```bash
node dist/cli.js doctor
node dist/cli.js plan "Create a health endpoint"
node dist/cli.js run "Create a health endpoint"
```

Compatibility note: the current v1 build keeps the existing `LITTLE_HELPER_*` environment variables, `.little-helper.config.json`, and `.little-helper/` artifact paths for backwards compatibility.

Workspace-local `.env` loading is supported, so the same variables can live in a file that matches [`.env.example`](.env.example).

For Docker, prefer the `Dockerfile` build and `docker run` flow:

```bash
docker build -t argus-agent .
docker run --rm argus-agent version
```

Live container checks against the current workspace:

```bash
docker run --rm \
  -e LITTLE_HELPER_LLM_PROVIDER=openai \
  -e LITTLE_HELPER_LLM_MODEL=gpt-5.4 \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -v "$PWD:/workspace" \
  -w /workspace \
  argus-agent doctor

docker run --rm \
  -e LITTLE_HELPER_LLM_PROVIDER=openai \
  -e LITTLE_HELPER_LLM_MODEL=gpt-5.4 \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -v "$PWD:/workspace" \
  -w /workspace \
  argus-agent plan "Create a health endpoint"

docker run --rm \
  -e LITTLE_HELPER_LLM_PROVIDER=openai \
  -e LITTLE_HELPER_LLM_MODEL=gpt-5.4 \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -v "$PWD:/workspace" \
  -w /workspace \
  argus-agent run "Create a health endpoint"
```

To persist artifacts in a separate host directory:

```bash
docker run --rm \
  -e LITTLE_HELPER_LLM_PROVIDER=openai \
  -e LITTLE_HELPER_LLM_MODEL=gpt-5.4 \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e LITTLE_HELPER_ARTIFACT_DIR=/artifacts \
  -v "$PWD:/workspace" \
  -v "$PWD/.little-helper:/artifacts" \
  -w /workspace \
  argus-agent run "Create a health endpoint"
```

The checked-in [`docker-compose.yml`](docker-compose.yml) is only a convenience wrapper for container smoke testing. For reliable end-to-end agent runs, use the explicit `docker build` and `docker run` commands above.

## Commands

- `argus run "TASK"`
- `argus plan "TASK"`
- `argus eval RUN_ID`
- `argus status RUN_ID`
- `argus logs RUN_ID`
- `argus artifacts RUN_ID`
- `argus config validate`
- `argus doctor`
- `argus resume RUN_ID`
- `argus cancel RUN_ID`
- `argus tools list`
- `argus mcp list`
- `argus mcp inspect SERVER_NAME`
- `argus approvals RUN_ID`
- `argus sessions RUN_ID`

## Approval Workflow

When a run enters `awaiting_approval`, inspect and decide the pending request, then resume:

```bash
argus approvals RUN_ID
argus approvals RUN_ID --approve APPROVAL_ID
argus resume RUN_ID
```

The runtime also persists a condensed `context-summary.md` and `context-sources.json` for each run so resume and review do not depend on replaying the full transcript.

## Validation Behavior

Evaluator validation is workspace-aware:

- If `validationCommands` are configured, those commands are run exactly as configured.
- If no validation commands are configured, the evaluator auto-detects supported validation in the workspace.
- In the current build, Node.js workspaces with a `package.json` test script auto-run `npm test` or `pnpm test`.
- Empty or non-matching workspaces do not fail just because a generic default test command exists elsewhere.

Each run writes the final validation outcome into `evaluation.json`, including `validationDecisions` that show whether a command was configured, auto-detected, passed, failed, or skipped.

## Session Supervision

Persisted shell sessions can now be inspected and reconciled from the CLI:

```bash
argus sessions RUN_ID
argus sessions RUN_ID --inspect SESSION_ID
argus sessions RUN_ID --reconcile
argus sessions RUN_ID --cancel SESSION_ID
```

Session records include PID, terminal status, termination reason, and end timestamp when known. Recovery uses the same persisted session data to distinguish still-running processes from stale session records after a restart.

## Development

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

Run artifacts are written under `.little-helper/runs/` by default.
