import type { ArtifactStore } from "../memory/artifact-store.js";
import { createEvent } from "../telemetry/events.js";
import {
  LLMUsageTelemetryDetailsSchema,
  TokenUsageSnapshotSchema,
  type ContextCompactionMode,
  type RunBudgetState,
  type TokenUsageSnapshot,
} from "../schemas.js";
import type { LLMGenerateRequest } from "./client.js";

export class TokenUsageTracker {
  public constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly runId: string,
    private readonly budget: RunBudgetState,
    private readonly onTelemetryEvent?: (event: ReturnType<typeof createEvent>) => void | Promise<void>,
  ) {}

  public async record(input: {
    phase: LLMGenerateRequest["role"];
    provider: string;
    model: string;
    contextWindowTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number | undefined;
    reasoningOutputTokens?: number | undefined;
    promptChars: number;
    stage: "preflight" | "compaction" | "response";
    compactionMode: ContextCompactionMode;
  }): Promise<TokenUsageSnapshot> {
    const usagePercent = roundUsagePercent(input.inputTokens, input.contextWindowTokens);
    this.budget.maxPromptTokens = input.contextWindowTokens;
    if (input.stage === "response") {
      this.budget.promptTokensUsed += input.inputTokens;
    }
    this.budget.lastInputTokens = input.inputTokens;
    this.budget.lastOutputTokens = input.outputTokens;
    this.budget.lastTotalTokens = input.totalTokens;
    this.budget.lastUsagePercent = usagePercent;
    this.budget.peakUsagePercent = Math.max(this.budget.peakUsagePercent, usagePercent);
    this.budget.activeModel = input.model;

    const snapshot = TokenUsageSnapshotSchema.parse({
      runId: this.runId,
      phase: input.phase,
      model: input.model,
      provider: input.provider,
      contextWindowTokens: input.contextWindowTokens,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      reasoningOutputTokens: input.reasoningOutputTokens ?? 0,
      usagePercent,
      peakUsagePercent: this.budget.peakUsagePercent,
      maxPromptTokens: input.contextWindowTokens,
      promptChars: input.promptChars,
      compactionCount: this.budget.compactionCount,
      compactionMode: input.compactionMode,
      stage: input.stage,
      timestamp: new Date().toISOString(),
    });

    await this.artifactStore.writeJson("token-usage.json", snapshot);
    await this.artifactStore.appendJsonl("token-usage-history.jsonl", snapshot);

    const details = LLMUsageTelemetryDetailsSchema.parse({
      phase: snapshot.phase,
      model: snapshot.model,
      provider: snapshot.provider,
      contextWindowTokens: snapshot.contextWindowTokens,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      totalTokens: snapshot.totalTokens,
      cachedInputTokens: snapshot.cachedInputTokens,
      reasoningOutputTokens: snapshot.reasoningOutputTokens,
      usagePercent: snapshot.usagePercent,
      peakUsagePercent: snapshot.peakUsagePercent,
      compactionCount: snapshot.compactionCount,
      compactionMode: snapshot.compactionMode,
      stage: snapshot.stage,
    });
    await this.onTelemetryEvent?.(
      createEvent({
        runId: this.runId,
        event: "llm.usage.updated",
        status: "success",
        details,
      }),
    );

    return snapshot;
  }
}

function roundUsagePercent(inputTokens: number, contextWindowTokens: number): number {
  return Number(((inputTokens / contextWindowTokens) * 100).toFixed(1));
}
