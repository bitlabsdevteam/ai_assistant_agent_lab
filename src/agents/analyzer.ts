import { buildAnalyzerPrompt } from "../llm/prompts.js";
import { AnalysisResultSchema, type AnalysisResult, type RunRequest } from "../schemas.js";
import type { Agent, AgentRuntimeContext } from "./base.js";

export class AnalyzerAgent implements Agent<RunRequest, AnalysisResult> {
  public readonly name = "analyzer";

  public async run(input: RunRequest, context: AgentRuntimeContext): Promise<AnalysisResult> {
    const prompt = buildAnalyzerPrompt(input, context.contextSnapshot);
    const response = await context.llm.generateObject(
      {
        role: "analyzer",
        prompt,
        input,
      },
      AnalysisResultSchema,
    );
    context.budget.promptCharsUsed += response.promptChars;
    context.budget.estimatedCostUsd += response.estimatedCostUsd;
    return AnalysisResultSchema.parse(response.object);
  }
}
