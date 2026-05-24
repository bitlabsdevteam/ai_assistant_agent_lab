# Deployment

## Container build

```bash
docker build -t little-helper-agent .
docker run --rm little-helper-agent version
```

## Runtime requirements

- Inject environment variables through the deployment platform.
- Mount persistent storage for `.little-helper/runs`.
- Use `LITTLE_HELPER_LLM_PROVIDER=mock` for offline/local smoke tests.
- Use explicit provider, model, approval mode, and artifact retention settings in production.
