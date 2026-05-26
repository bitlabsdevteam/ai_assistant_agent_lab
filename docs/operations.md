# Operations

## Routine checks

- `argus doctor`
- `argus status RUN_ID`
- `argus logs RUN_ID`
- `argus artifacts RUN_ID`
- Ensure the credential for every resolved provider route is present before relying on `doctor` or live runs:
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `MOONSHOT_API_KEY`.
- When using `web.search`, ensure `PERPLEXITY_API_KEY` is present in the workspace `.env` or process environment.
- Add `api.perplexity.ai` to `networkAllowlist` before expecting Perplexity-backed web search to pass policy checks.
- When `llmRouting` is configured, `doctor` reports the aggregated health of the resolved analyzer, executor, and evaluator routes instead of only one global provider.
- If an operator overrides provider or model through CLI flags, chat session state, or the headless API, that selection is persisted with the run request and reused on resume.

## Recovery

- `argus resume RUN_ID` resumes from the latest durable checkpoint.
- `argus recover RUN_ID` inspects lease and checkpoint state before resuming.
- `argus cancel RUN_ID` marks the run cancelled without deleting artifacts.
- `argus approvals RUN_ID --approve APPROVAL_ID` records an approval decision before resume.
- `argus approvals RUN_ID --deny APPROVAL_ID` records a denial and keeps the run auditable.
- `argus sessions RUN_ID --inspect SESSION_ID` refreshes one persisted session against the local process table.
- `argus sessions RUN_ID --reconcile` reconciles all persisted running sessions.
- `argus sessions RUN_ID --cancel SESSION_ID` sends `SIGTERM` when the tracked PID is still alive, then records cancellation durably.

## Troubleshooting

- Review `events.jsonl`, `harness-state.json`, and `checkpoints/`.
- Inspect `approvals.json` for blocked or stale approval states.
- Inspect `sessions.json` for hung process sessions.
- Inspect `evaluation.json` for `validationDecisions` when a run passes or fails due to configured or auto-detected validation.
