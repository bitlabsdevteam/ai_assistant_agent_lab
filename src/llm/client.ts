import type { z } from "zod";

import type { LLMTokenCount, PromptEnvelope } from "../schemas.js";

export interface LLMStreamEvent {
  role: "analyzer" | "executor" | "evaluator";
  type: string;
  delta?: string;
  data?: unknown;
  stepId?: string;
  stepTitle?: string;
  stepHasTools?: boolean;
}

export interface LLMStreamCallbacks {
  onTextDelta?: (delta: string) => void | Promise<void>;
  onEvent?: (event: Omit<LLMStreamEvent, "role">) => void | Promise<void>;
}

export interface LLMGenerateRequest {
  role: "analyzer" | "executor" | "evaluator";
  prompt: PromptEnvelope;
  input: unknown;
  stream?: LLMStreamCallbacks;
  signal?: AbortSignal;
}

export interface LLMGenerateResponse<T> {
  object: T;
  model: string;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  contextWindowTokens?: number;
  estimatedCostUsd: number;
}

export interface LLMClient {
  countTokens<T>(request: LLMGenerateRequest, schema?: z.ZodType<T>): Promise<LLMTokenCount>;
  generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
}
