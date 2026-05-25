import { AppError } from "../errors.js";
import type { RunBudgetState } from "../schemas.js";

export class BudgetManager {
  public ensureWithinLimits(budget: RunBudgetState): void {
    if (budget.toolCallsUsed > (budget.maxToolCalls ?? Number.MAX_SAFE_INTEGER)) {
      throw new AppError("VALIDATION_ERROR", "Tool call budget exceeded.");
    }
    if (budget.lastInputTokens > (budget.maxPromptTokens ?? Number.MAX_SAFE_INTEGER)) {
      throw new AppError("VALIDATION_ERROR", "Prompt token budget exceeded.");
    }
    if (budget.estimatedCostUsd > (budget.maxCostUsd ?? Number.MAX_SAFE_INTEGER)) {
      throw new AppError("VALIDATION_ERROR", "Cost budget exceeded.");
    }
  }
}
