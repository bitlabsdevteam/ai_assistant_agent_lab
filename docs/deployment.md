# Deployment

For customer install and integration guidance, start with [customer-install-and-integration.md](./customer-install-and-integration.md).

The current deployment model has two supported paths:

- CLI-first local or containerized usage.
- Advanced embedding through the exported SDK and headless API runtime.

There is not currently a dedicated `little-helper serve` command. API deployment requires a small custom Node bootstrap around `HeadlessPlatform` and `createHeadlessApiServer`.

## Container build

```bash
docker build -t little-helper-agent .
docker run --rm little-helper-agent version
```

## Runtime requirements

- Inject environment variables through the deployment platform.
- Mount persistent storage for `.little-helper/runs`.
- Provide `OPENAI_API_KEY` for every deployed environment.
- Set `LITTLE_HELPER_LLM_PROVIDER=openai` and `LITTLE_HELPER_LLM_MODEL=<chosen model>`.
- If enabling `web.search`, provide `PERPLEXITY_API_KEY` and allowlist `api.perplexity.ai`.
- Use explicit model, approval mode, and artifact retention settings in production.
