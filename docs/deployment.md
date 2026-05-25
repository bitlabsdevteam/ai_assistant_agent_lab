# Deployment

## Container build

```bash
docker build -t little-helper-agent .
docker run --rm little-helper-agent version
```

## Runtime requirements

- Inject environment variables through the deployment platform.
- Mount persistent storage for `.little-helper/runs`.
- Provide `OPENAI_API_KEY` for every deployed environment.
- Use explicit model, approval mode, and artifact retention settings in production.
