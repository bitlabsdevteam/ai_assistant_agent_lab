import { z } from "zod";

import { AppError } from "../errors.js";
import { zodToJsonSchema } from "./json-schema.js";

export type JsonSchema = Record<string, unknown>;

export const MAX_GENERATE_ATTEMPTS = 3;
export const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 520, 522, 524]);

export function estimateInputTokens(body: Record<string, unknown>): number {
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
}

export function normalizeUsageTotals(
  inputTokens: number,
  outputTokens: number,
  extras?: {
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  },
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
} {
  return {
    inputTokens,
    outputTokens,
    totalTokens: extras?.totalTokens ?? inputTokens + outputTokens,
    cachedInputTokens: extras?.cachedInputTokens ?? 0,
    reasoningOutputTokens: extras?.reasoningOutputTokens ?? 0,
  };
}

export function buildTransportSchema<T>(
  schema: z.ZodType<T>,
  name: string,
  provider: string,
): {
  schema: JsonSchema;
  unwrap: (value: unknown) => unknown;
} {
  const jsonSchema = zodToJsonSchema(schema, name);
  if (jsonSchema.type === "object") {
    return {
      schema: jsonSchema,
      unwrap: (value) => value,
    };
  }

  return {
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: name,
      type: "object",
      properties: {
        data: jsonSchema,
      },
      required: ["data"],
      additionalProperties: false,
    },
    unwrap: (value) => {
      if (typeof value !== "object" || value === null || !("data" in value)) {
        throw new AppError("LLM_ERROR", `${provider} response did not match the wrapped structured output shape.`);
      }
      return (value as { data: unknown }).data;
    },
  };
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 0 ? text : response.statusText;
  } catch {
    return response.statusText;
  }
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

export function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

export function backoffForAttempt(attempt: number): number {
  return attempt * attempt * 250;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parsePossibleJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function looksLikeHtml(value: string): boolean {
  const sample = value.trim().slice(0, 256).toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html");
}

export function buildRetryHeaders(
  stream: boolean,
  authHeader: Record<string, string>,
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    ...authHeader,
  };
}
