# Operations

## Routine checks

- `little-helper doctor`
- `little-helper status RUN_ID`
- `little-helper logs RUN_ID`
- `little-helper artifacts RUN_ID`
- When `llmProvider=openai`, ensure `OPENAI_API_KEY` is present before relying on `doctor` or live runs.
- When `llmRouting` is configured, `doctor` reports the aggregated health of the resolved analyzer, executor, and evaluator routes instead of only one global provider.

## Recovery

- `little-helper resume RUN_ID` resumes from the latest durable checkpoint.
- `little-helper recover RUN_ID` inspects lease and checkpoint state before resuming.
- `little-helper cancel RUN_ID` marks the run cancelled without deleting artifacts.
- `little-helper approvals RUN_ID --approve APPROVAL_ID` records an approval decision before resume.
- `little-helper approvals RUN_ID --deny APPROVAL_ID` records a denial and keeps the run auditable.
- `little-helper sessions RUN_ID --inspect SESSION_ID` refreshes one persisted session against the local process table.
- `little-helper sessions RUN_ID --reconcile` reconciles all persisted running sessions.
- `little-helper sessions RUN_ID --cancel SESSION_ID` sends `SIGTERM` when the tracked PID is still alive, then records cancellation durably.

## Troubleshooting

- Review `events.jsonl`, `harness-state.json`, and `checkpoints/`.
- Inspect `approvals.json` for blocked or stale approval states.
- Inspect `sessions.json` for hung process sessions.
- Inspect `evaluation.json` for `validationDecisions` when a run passes or fails due to configured or auto-detected validation.
