import {
  buildAnalyzerPromptEnvelope,
  buildPromptArtifactRecord,
  renderPromptEnvelopeForTransport,
} from "../llm/prompts.js";
import { preparePromptWithTokenBudget } from "./llm-preflight.js";
import { AnalysisResultSchema, type AnalysisResult, type RunRequest } from "../schemas.js";
import type { Agent, AgentRuntimeContext } from "./base.js";

export class AnalyzerAgent implements Agent<RunRequest, AnalysisResult> {
  public readonly name = "analyzer";

  public async run(input: RunRequest, context: AgentRuntimeContext): Promise<AnalysisResult> {
    const availableTools = context.tools.list().map((tool) => ({
      name: tool.descriptor.name,
      description: tool.descriptor.description,
      sideEffecting: tool.descriptor.sideEffecting,
      category: tool.descriptor.category,
    }));
    const promptPreparation = await preparePromptWithTokenBudget({
      role: "analyzer",
      llmInput: input,
      schema: AnalysisResultSchema,
      context,
      buildPrompt: (compactionMode) =>
        buildAnalyzerPromptEnvelope(
          input,
          availableTools,
          context.contextSnapshot,
          {
            dryRun: context.dryRun,
            permissions: context.permissions,
            approvalMode: context.settings.approvalMode,
            ...(context.operatorMode ? { operatorMode: context.operatorMode } : {}),
          },
          compactionMode,
        ),
    });
    const prompt = promptPreparation.prompt;
    await context.artifactStore.writeJson(
      "prompt-envelope-analyzer.json",
      {
        envelope: prompt,
        transport: renderPromptEnvelopeForTransport(prompt, input),
      },
      {
        confidentiality: "metadata_only",
        metadata: buildPromptArtifactRecord(prompt),
      },
    );
    const response = await context.llm.generateObject(
      {
        role: "analyzer",
        prompt,
        input,
        signal: context.signal,
        ...(context.onLLMEvent
          ? {
              stream: {
                onTextDelta: (delta) => context.onLLMEvent?.({ role: "analyzer", type: "response.output_text.delta", delta }),
                onEvent: (event) => context.onLLMEvent?.({ role: "analyzer", ...event }),
              },
            }
          : {}),
      },
      AnalysisResultSchema,
    );
    await context.usageTracker.record({
      phase: "analyzer",
      provider: promptPreparation.count.provider,
      model: response.model,
      contextWindowTokens: response.contextWindowTokens ?? promptPreparation.count.contextWindowTokens,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      totalTokens: response.totalTokens,
      cachedInputTokens: response.cachedInputTokens,
      reasoningOutputTokens: response.reasoningOutputTokens,
      promptChars: response.promptChars,
      stage: "response",
      compactionMode: promptPreparation.compactionMode,
    });
    context.budget.promptCharsUsed += response.promptChars;
    context.budget.estimatedCostUsd += response.estimatedCostUsd;
    return AnalysisResultSchema.parse(response.object);
  }
}
