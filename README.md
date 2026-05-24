# ai_assistant_agent_lab

# little-helper-agent

`little-helper` is a CLI-first multi-agent runtime with separate analyzer, executor, and evaluator agents, durable run artifacts, policy-gated tool execution, and resumable harness state.

## Requirements

- Node.js 22+
- `pnpm` 9+

## Install

```bash
pnpm install
pnpm build
```

## LLM Providers

The runtime supports:

- `mock`: offline deterministic behavior for local development and tests
- `openai`: real OpenAI Responses API integration with structured JSON output

Minimal OpenAI configuration:

```bash
export LITTLE_HELPER_LLM_PROVIDER=openai
export LITTLE_HELPER_LLM_MODEL=gpt-4.1-mini
export OPENAI_API_KEY=...
```

Optional settings:

- `LITTLE_HELPER_LLM_BASE_URL`
- `LITTLE_HELPER_LLM_ORGANIZATION`
- `LITTLE_HELPER_LLM_PROJECT`

`little-helper doctor` now checks configured OpenAI reachability with the selected model when `llmProvider=openai`.

Role-specific routing can be configured in `.little-helper.config.json`:

```json
{
  "llmProvider": "mock",
  "llmModel": "mock-default",
  "llmRouting": {
    "analyzer": {
      "provider": "openai",
      "model": "gpt-4.1-mini"
    },
    "evaluator": {
      "provider": "openai",
      "model": "gpt-4.1"
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

## Commands

- `little-helper run "TASK"`
- `little-helper plan "TASK"`
- `little-helper eval RUN_ID`
- `little-helper status RUN_ID`
- `little-helper logs RUN_ID`
- `little-helper artifacts RUN_ID`
- `little-helper config validate`
- `little-helper doctor`
- `little-helper resume RUN_ID`
- `little-helper cancel RUN_ID`
- `little-helper tools list`
- `little-helper mcp list`
- `little-helper mcp inspect SERVER_NAME`
- `little-helper approvals RUN_ID`
- `little-helper sessions RUN_ID`

## Approval Workflow

When a run enters `awaiting_approval`, inspect and decide the pending request, then resume:

```bash
little-helper approvals RUN_ID
little-helper approvals RUN_ID --approve APPROVAL_ID
little-helper resume RUN_ID
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
little-helper sessions RUN_ID
little-helper sessions RUN_ID --inspect SESSION_ID
little-helper sessions RUN_ID --reconcile
little-helper sessions RUN_ID --cancel SESSION_ID
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
