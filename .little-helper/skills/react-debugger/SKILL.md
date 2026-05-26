---
name: react-debugger
description: Debug React rendering, hook state, and component update issues.
triggers:
  - rerender loop
  - infinite rerender
  - too many re-renders
  - hooks issue
  - stale closure
tags:
  - react
  - frontend
  - hooks
  - debugging
tools:
  - fs.read
  - fs.search
  - fs.diff
  - shell.exec
version: 1
enabled: true
---
# React Debugger

Use this skill when a task mentions React components re-rendering unexpectedly, hook dependency bugs, stale closures, or state updates that fire in the wrong phase.

## Objectives

- Identify the exact component or hook causing the render churn.
- Distinguish between expected rerenders and a real loop.
- Prefer the smallest code change that removes the root cause.

## Workflow

1. Inspect the affected component tree, custom hooks, and nearby state management before editing.
2. Trace what triggers each render: prop changes, context updates, effect dependencies, derived state, or async callbacks.
3. Check for common faults:
   - state setters called during render
   - effects that update values listed in their own dependency arrays
   - unstable object, array, or function identities recreated every render
   - stale closures in timers, subscriptions, or async handlers
   - Strict Mode double-invocation being mistaken for a production loop
4. Confirm whether the bug is local to one component, shared through context, or caused by parent churn.
5. Apply the narrowest fix, then verify the rerender pattern changed for the intended reason.

## Preferred Tactics

- Read the component and the hook definitions before proposing memoization.
- Favor removing unnecessary effects over adding defensive memo wrappers.
- When dependencies are unstable, fix the source of instability instead of suppressing lint rules.
- If memoization is required, explain which identity was unstable and why memoization is safe.
- Keep React behavior explanations concrete: mention the component, hook, and triggering state path.

## Verification

- Re-check the edited component and any related hooks for new dependency mistakes.
- Run focused validation commands when available.
- Summarize the root cause, the exact fix, and any remaining risk such as Strict Mode only behavior.
