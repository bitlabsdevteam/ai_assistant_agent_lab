import type { z } from "zod";

import { AppError } from "../errors.js";
import { renderPromptEnvelopeForTransport } from "../llm/prompts.js";
import type { LLMGenerateRequest } from "../llm/client.js";
import type { AgentRuntimeContext } from "./base.js";
import type { ContextCompactionMode, PromptEnvelope } from "../schemas.js";

const COMPACTION_SEQUENCE: ContextCompactionMode[] = ["full", "compact", "aggressive"];

export async function preparePromptWithTokenBudget<T>(input: {
  role: LLMGenerateRequest["role"];
  llmInput: unknown;
  schema: z.ZodType<T>;
  context: AgentRuntimeContext;
  buildPrompt: (mode: ContextCompactionMode) => PromptEnvelope;
}): Promise<{
  prompt: PromptEnvelope;
  compactionMode: ContextCompactionMode;
  count: Awaited<ReturnType<AgentRuntimeContext["llm"]["countTokens"]>>;
}> {
  let prompt = input.buildPrompt("full");
  let compactionMode: ContextCompactionMode = "full";
  let count = await countAndRecord(input.context, input.role, prompt, input.llmInput, input.schema, "preflight", compactionMode);

  const thresholdPercent = input.context.settings.contextCompactionThresholdPercent;
  if (count.inputTokens / count.contextWindowTokens < thresholdPercent / 100) {
    return { prompt, compactionMode, count };
  }

  for (const nextMode of COMPACTION_SEQUENCE.slice(1)) {
    compactionMode = nextMode;
    input.context.budget.compactionCount += 1;
    prompt = input.buildPrompt(compactionMode);
    count = await countAndRecord(input.context, input.role, prompt, input.llmInput, input.schema, "compaction", compactionMode);
    const usagePercent = count.inputTokens / count.contextWindowTokens;
    if (nextMode === "aggressive" || usagePercent < thresholdPercent / 100) {
      return { prompt, compactionMode, count };
    }
  }

  if (count.inputTokens > count.contextWindowTokens) {
    const transport = renderPromptEnvelopeForTransport(prompt, input.llmInput);
    const oversizedArtifact = await input.context.artifactStore.writeArtifactJson(`oversized-context-${input.role}.json`, {
      role: input.role,
      model: count.model,
      provider: count.provider,
      compactionMode,
      inputTokens: count.inputTokens,
      contextWindowTokens: count.contextWindowTokens,
      usagePercent: Number(((count.inputTokens / count.contextWindowTokens) * 100).toFixed(1)),
      promptChars: transport.promptChars,
      prompt,
      transport,
    });
    throw new AppError("VALIDATION_ERROR", `Prompt exceeds model context window for ${input.role}:${count.model}.`, {
      details: {
        role: input.role,
        model: count.model,
        inputTokens: count.inputTokens,
        contextWindowTokens: count.contextWindowTokens,
        oversizedArtifact,
      },
    });
  }

  return { prompt, compactionMode, count };
}

async function countAndRecord<T>(
  context: AgentRuntimeContext,
  role: LLMGenerateRequest["role"],
  prompt: PromptEnvelope,
  llmInput: unknown,
  schema: z.ZodType<T>,
  stage: "preflight" | "compaction",
  compactionMode: ContextCompactionMode,
): Promise<Awaited<ReturnType<AgentRuntimeContext["llm"]["countTokens"]>>> {
  const count = await context.llm.countTokens(
    {
      role,
      prompt,
      input: llmInput,
      signal: context.signal,
    },
    schema,
  );
  const transport = renderPromptEnvelopeForTransport(prompt, llmInput);
  await context.usageTracker.record({
    phase: role,
    provider: count.provider,
    model: count.model,
    contextWindowTokens: count.contextWindowTokens,
    inputTokens: count.inputTokens,
    outputTokens: 0,
    totalTokens: count.inputTokens,
    promptChars: transport.promptChars,
    stage,
    compactionMode,
  });
  return count;
}
