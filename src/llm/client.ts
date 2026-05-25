import type { z } from "zod";

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
  prompt: string;
  input: unknown;
  stream?: LLMStreamCallbacks;
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
