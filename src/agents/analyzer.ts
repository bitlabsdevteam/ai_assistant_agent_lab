import {
  buildAnalyzerPromptEnvelope,
  buildPromptArtifactRecord,
  renderPromptEnvelopeForTransport,
} from "../llm/prompts.js";
import { AnalysisResultSchema, type AnalysisResult, type RunRequest } from "../schemas.js";
import type { Agent, AgentRuntimeContext } from "./base.js";

export class AnalyzerAgent implements Agent<RunRequest, AnalysisResult> {
  public readonly name = "analyzer";

  public async run(input: RunRequest, context: AgentRuntimeContext): Promise<AnalysisResult> {
    const prompt = buildAnalyzerPromptEnvelope(
      input,
      context.tools.list().map((tool) => ({
        name: tool.descriptor.name,
        description: tool.descriptor.description,
        sideEffecting: tool.descriptor.sideEffecting,
        category: tool.descriptor.category,
      })),
      context.contextSnapshot,
      {
        dryRun: context.dryRun,
        permissions: context.permissions,
        approvalMode: context.settings.approvalMode,
        ...(context.operatorMode ? { operatorMode: context.operatorMode } : {}),
      },
    );
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
    context.budget.promptCharsUsed += response.promptChars;
    context.budget.estimatedCostUsd += response.estimatedCostUsd;
    return AnalysisResultSchema.parse(response.object);
  }
}
