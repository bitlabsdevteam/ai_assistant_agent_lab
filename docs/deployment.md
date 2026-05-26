# Deployment

For customer install and integration guidance, start with [customer-install-and-integration.md](./customer-install-and-integration.md).

The current deployment model has two supported paths:

- CLI-first local or containerized usage.
- Advanced embedding through the exported SDK and headless API runtime.

There is not currently a dedicated `argus serve` command. API deployment requires a small custom Node bootstrap around `HeadlessPlatform` and `createHeadlessApiServer`.

## Container build

```bash
docker build -t argus-agent .
docker run --rm argus-agent version
```

## Local verification

Use this path when you want to verify the repository itself without calling a live model:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

For a real OpenAI-backed agent run:

```bash
export LITTLE_HELPER_LLM_PROVIDER=openai
export LITTLE_HELPER_LLM_MODEL=gpt-5.4
export OPENAI_API_KEY=...

pnpm dev -- doctor
pnpm dev -- plan "Create a health endpoint"
pnpm dev -- run "Create a health endpoint"
```

The runtime also reads a workspace `.env`, so the same values can be stored in the same format as `.env.example`.

## Containerized verification

The recommended container test path is the Dockerfile-based `docker build` and `docker run` flow:

```bash
docker build -t argus-agent .
docker run --rm argus-agent version
```

To run against the current workspace with OpenAI credentials:

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

To persist run artifacts outside the mounted workspace:

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

The checked-in `docker-compose.yml` is intentionally limited to a simple container smoke path. It should not be treated as the default end-to-end agent test workflow.

## Runtime requirements

- Inject environment variables through the deployment platform.
- Mount persistent storage for `.little-helper/runs`.
- Provide `OPENAI_API_KEY` for every deployed environment.
- Set `LITTLE_HELPER_LLM_PROVIDER=openai` and `LITTLE_HELPER_LLM_MODEL=<chosen model>`.
- If enabling `web.search`, provide `PERPLEXITY_API_KEY` and allowlist `api.perplexity.ai`.
- Use explicit model, approval mode, and artifact retention settings in production.
