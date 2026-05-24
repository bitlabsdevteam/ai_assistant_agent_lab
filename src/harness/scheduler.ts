import type { EvaluationResult, HarnessStatus } from "../schemas.js";

export class Scheduler {
  public nextStatusFromEvaluation(result: EvaluationResult): HarnessStatus {
    switch (result.status) {
      case "pass":
        return "completed";
      case "fail":
        return "failed";
      case "needs_revision":
        return "revising";
    }
  }
}
