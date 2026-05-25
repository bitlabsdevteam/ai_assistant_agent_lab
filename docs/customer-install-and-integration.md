# Customer Install and Integration Guide

Yes. A customer can use `little-helper` today if they are comfortable self-hosting a Node.js CLI or service and supplying OpenAI credentials. The most production-ready entry point today is the CLI, Docker packaging exists for deployment, and the repository also exposes a tested SDK plus headless HTTP/SSE runtime for embedding. One important constraint applies up front: there is not currently a first-class `little-helper serve` command, so API deployment requires a small custom Node host that wraps the exported runtime objects.

## Recommended Adoption Path

Use the product in one of two supported ways:

1. Primary path: local or containerized CLI usage.
2. Advanced path: embed via the exported SDK and headless API primitives.

The default recommendation is CLI-first adoption for customer engineers. The API path is intended for teams embedding the runtime into an existing product or control plane.

## Prerequisites

Customers should provision these prerequisites before installation:

- Node.js `22+`
- `pnpm` `9+`
- `OPENAI_API_KEY`
- Optional `PERPLEXITY_API_KEY` for `web.search`
- Persistent storage for `.little-helper/runs`

OpenAI is the documented primary LLM provider. Perplexity-backed web search is optional and should be treated as an add-on.

## Install And Smoke Test

Install and validate the runtime in this order:

1. Clone the repository.
2. Run `pnpm install`.
3. Run `pnpm build`.
4. Export `LITTLE_HELPER_LLM_PROVIDER=openai`.
5. Export `LITTLE_HELPER_LLM_MODEL=<chosen model>`.
6. Export `OPENAI_API_KEY=<key>`.
7. Run `node dist/cli.js doctor` or `little-helper doctor` after linking or installing the package.
8. Run a smoke test with `little-helper plan "Create a health endpoint"` and then `little-helper run "Create a health endpoint"`.

Example shell session:

```bash
git clone <repo-url>
cd little_helper_agent
pnpm install
pnpm build

export LITTLE_HELPER_LLM_PROVIDER=openai
export LITTLE_HELPER_LLM_MODEL=gpt-5.4
export OPENAI_API_KEY=...

node dist/cli.js doctor
node dist/cli.js plan "Create a health endpoint"
node dist/cli.js run "Create a health endpoint"
```

If you package or link the CLI binary, the same checks become:

```bash
little-helper doctor
little-helper plan "Create a health endpoint"
little-helper run "Create a health endpoint"
```

## CLI Integration Path

The CLI is the default customer workflow and the most production-ready interface in the repository today. It uses the same analyzer, executor, evaluator, harness, policy, and artifact subsystems that the embedded runtime uses, but it avoids the extra hosting work required for the API path.

Recommended CLI workflow:

1. Install and build the binary.
2. Add a project-local `.little-helper.config.json`.
3. Configure `approvalMode`, `allowedRoots`, `networkAllowlist`, `validationCommands`, and optional `llmRouting`.
4. Run tasks with `little-helper run`.
5. Review state and artifacts with `status`, `logs`, `artifacts`, `eval`, `approvals`, and `sessions`.
6. Resume interrupted runs with `little-helper resume RUN_ID`.

Minimal project config:

```json
{
  "allowedRoots": ["."],
  "approvalMode": "on-risk",
  "networkAllowlist": ["api.perplexity.ai"],
  "validationCommands": [["pnpm", "test"]],
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

Notes:

- `allowedRoots` should point at the workspace paths the agent is allowed to read or modify.
- `approvalMode` is the main operational safety switch for customer deployments.
- `networkAllowlist` is required for policy-gated network tools. Add `api.perplexity.ai` only if you want `web.search`.
- `validationCommands` are arrays of argv tokens, not shell strings.
- Global `llmProvider` and `llmModel` act as defaults. `llmRouting` overrides specific analyzer, executor, or evaluator roles.

Typical CLI commands for customer operations:

- `little-helper run "TASK"`
- `little-helper plan "TASK"`
- `little-helper doctor`
- `little-helper resume RUN_ID`
- `little-helper status RUN_ID`
- `little-helper logs RUN_ID`
- `little-helper artifacts RUN_ID`
- `little-helper eval RUN_ID`
- `little-helper approvals RUN_ID`
- `little-helper sessions RUN_ID`

Approval-aware deployments normally follow this flow:

```bash
little-helper approvals RUN_ID
little-helper approvals RUN_ID --approve APPROVAL_ID
little-helper resume RUN_ID
```

Container deployment is supported, but it is only packaging around the same CLI/runtime. It does not change the operational model.

## Advanced SDK And Headless API Path

Use this path when the customer wants to embed the runtime in an existing application, developer portal, or internal platform. This is supported, but it is not the default recommendation because there is no built-in `little-helper serve` command yet.

Current embeddable surfaces:

- SDK client contract in [packages/sdk/src/index.ts](../packages/sdk/src/index.ts)
- Runtime exports in [src/index.ts](../src/index.ts)
- Headless HTTP + SSE handlers in [src/server/app.ts](../src/server/app.ts)

Exported runtime objects to build around:

- `HeadlessPlatform`
- `createHeadlessApiServer`
- `Orchestrator`
- schemas and types from `src/index.ts`

In practice, the customer must create a small Node host process that:

1. Loads settings.
2. Constructs repositories and the runtime platform.
3. Creates the HTTP server.
4. Binds a port.
5. Injects bearer-auth API keys.
6. Mounts persistent artifact storage.

Minimal host shape:

```ts
import { loadSettings, HeadlessPlatform, createHeadlessApiServer } from "little-helper-agent";
import { createCustomerRepositoryBundle } from "./repositories.js";

const settings = await loadSettings(process.cwd());
const repositories = await createCustomerRepositoryBundle();
const platform = new HeadlessPlatform(settings, repositories, {
  worker: {
    autostart: true,
  },
});

const server = createHeadlessApiServer(platform);
server.listen(process.env.PORT ?? 3000);
```

That wrapper is also where customers should:

- back `platform.authenticate()` with real API-key storage,
- provide durable repositories for sessions, runs, approvals, jobs, and events,
- keep `.little-helper/runs` or `LITTLE_HELPER_ARTIFACT_DIR` on persistent storage,
- terminate and restart the host like any other Node service,
- expose the service behind TLS, ingress, and standard service monitoring.

The repository includes tested headless API and SDK behavior, but customers still own the server bootstrap, auth wiring, and persistence design.

### SDK Client Surfaces

The SDK currently exposes these client methods:

- `sessions.create`
- `sessions.get`
- `sessions.listMessages`
- `chat.sendMessage`
- `chat.sendMessageStream`
- `runs.get`
- `runs.stream`
- `approvals.list`
- `approvals.decide`

### Headless HTTP And SSE Surfaces

The headless API currently exposes these routes:

- `GET /v1/health`
- `POST /v1/sessions`
- `GET /v1/sessions/:id`
- `GET /v1/sessions/:id/messages`
- `POST /v1/sessions/:id/messages`
- `GET /v1/runs/:id`
- `GET /v1/runs/:id/stream`
- `GET /v1/runs/:id/approvals`
- `POST /v1/approvals/:id/decision`

SSE streaming is part of the intended integration model. API consumers should plan to consume `GET /v1/runs/:id/stream` for live run status, assistant output deltas, approval events, and terminal completion/failure signals.

## Public Interfaces Customers Should Treat As Stable Entry Points

Customer-facing interfaces in the repository today:

- CLI commands: `run`, `plan`, `doctor`, `resume`, `status`, `logs`, `artifacts`, `eval`, `approvals`, `sessions`
- SDK client types and methods from [packages/sdk/src/index.ts](../packages/sdk/src/index.ts)
- Headless HTTP + SSE API from [src/server/app.ts](../src/server/app.ts)
- Config inputs from `.little-helper.config.json` and environment variables

There are additional CLI commands such as `tools list`, `config validate`, `cancel`, and `recover`, but the commands above are the core customer workflow to document first.

## Customer Validation Plan

Customers should validate installation and integration with this checklist:

1. Run `little-helper doctor`.
2. Run `little-helper tools list`.
3. Run `little-helper plan "simple task"`.
4. Run `little-helper run "simple task"` in a disposable workspace.
5. Run `little-helper artifacts RUN_ID`.
6. For API users, create one session, send one message, consume one SSE stream, and verify the terminal run status.
7. For approval-enabled deployments, force an approval-required run and verify approve/resume behavior.

For CLI-first customers, steps 1 through 5 are the minimum production-readiness smoke test.

## Operational Defaults And Assumptions

- Default recommendation: CLI-first adoption.
- Default audience: customer engineer, not a non-technical operator.
- Primary provider: OpenAI.
- Optional add-on: Perplexity-backed `web.search`.
- Container deployment: supported as packaging around the same runtime.
- Current API constraint: server deployment needs a custom bootstrap because there is no dedicated `serve` command yet.

If the customer wants the lowest integration risk today, start with the CLI, store artifacts on persistent disk, and add the headless API only when they need a product-embedded workflow.
