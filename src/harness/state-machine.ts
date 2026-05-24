import { AppError } from "../errors.js";
import type { HarnessRunState, HarnessStatus } from "../schemas.js";

const VALID_TRANSITIONS: Record<HarnessStatus, HarnessStatus[]> = {
  created: ["planning", "cancelled", "failed"],
  planning: ["awaiting_approval", "executing", "failed", "cancelled"],
  awaiting_approval: ["executing", "blocked", "cancelled", "failed"],
  executing: ["awaiting_approval", "evaluating", "revising", "failed", "cancelled"],
  evaluating: ["completed", "revising", "failed", "cancelled"],
  revising: ["executing", "failed", "cancelled"],
  paused: ["executing", "cancelled", "failed"],
  blocked: ["revising", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transitionRunState(state: HarnessRunState, nextStatus: HarnessStatus, phase: string): HarnessRunState {
  const allowed = VALID_TRANSITIONS[state.status];
  if (!allowed.includes(nextStatus)) {
    throw new AppError("VALIDATION_ERROR", `Invalid state transition: ${state.status} -> ${nextStatus}`);
  }
  return {
    ...state,
    status: nextStatus,
    phase,
    updatedAt: new Date().toISOString(),
  };
}
