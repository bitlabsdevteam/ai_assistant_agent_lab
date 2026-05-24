import type { z } from "zod";

export interface LLMGenerateRequest {
  role: "analyzer" | "executor" | "evaluator";
  prompt: string;
  input: unknown;
}

export interface LLMGenerateResponse<T> {
  object: T;
  model: string;
  promptChars: number;
  estimatedCostUsd: number;
}

export interface LLMClient {
  generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
}
