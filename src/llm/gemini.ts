import { z } from "zod";

import { AppError } from "../errors.js";
import { LLMTokenCountSchema, type LLMTokenCount } from "../schemas.js";
import type { LLMClient, LLMGenerateRequest, LLMGenerateResponse } from "./client.js";
import { assertStructuredOutputSupport } from "./capabilities.js";
import {
  MAX_GENERATE_ATTEMPTS,
  backoffForAttempt,
  buildTransportSchema,
  estimateInputTokens,
  isRetryableNetworkError,
  isRetryableStatus,
  normalizeUsageTotals,
  parsePossibleJson,
  safeReadText,
  sleep,
} from "./provider-utils.js";
import { renderPromptEnvelopeForTransport } from "./prompts.js";
import { resolveBuiltInContextWindow, type ResolvedLLMConfig } from "./routing.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(
              z.object({
                text: z.string().optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .default([]),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      totalTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  modelVersion: z.string().optional(),
});

export class GeminiClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  public constructor(private readonly config: ResolvedLLMConfig, env: NodeJS.ProcessEnv = process.env) {
    assertStructuredOutputSupport(config);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = env.GEMINI_API_KEY;
  }

  public async countTokens<T>(request: LLMGenerateRequest, schema?: z.ZodType<T>): Promise<LLMTokenCount> {
    const promptTransport = renderPromptEnvelopeForTransport(request.prompt, request.input);
    const body = this.buildRequestBody(promptTransport, request.role, schema);
    return LLMTokenCountSchema.parse({
      provider: this.config.provider,
      model: this.config.model,
      inputTokens: estimateInputTokens(body),
      contextWindowTokens: this.resolveContextWindowTokens(),
    });
  }

  public async generateObject<T>(
    request: LLMGenerateRequest,
    schema: z.ZodType<T>,
  ): Promise<LLMGenerateResponse<T>> {
    if (!this.apiKey) {
      throw new AppError("CONFIG_ERROR", "GEMINI_API_KEY is required when llmProvider is 'gemini'.");
    }

    const promptTransport = renderPromptEnvelopeForTransport(request.prompt, request.input);
    const shouldStream = request.stream !== undefined;
    const requestBody = JSON.stringify(this.buildRequestBody(promptTransport, request.role, schema));
    const path = shouldStream
      ? `/models/${encodeURIComponent(stripModelsPrefix(this.config.model))}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`
      : `/models/${encodeURIComponent(stripModelsPrefix(this.config.model))}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetchWithRetry(path, requestBody, shouldStream, request.signal);
    if (!response.ok) {
      throw new AppError("LLM_ERROR", `Gemini API failed (${response.status}): ${await safeReadText(response)}`);
    }

    const payload = shouldStream
      ? await this.consumeStreamedResponse(response, request.stream)
      : GeminiResponseSchema.parse(await response.json());
    const text = payload.candidates[0]?.content?.parts.map((part) => part.text ?? "").join("").trim();
    if (!text) {
      throw new AppError("LLM_ERROR", "Gemini response did not include structured JSON text.");
    }
    const transportSchema = buildTransportSchema(schema, `${request.role}_response`, "Gemini");
    const parsed = schema.parse(transportSchema.unwrap(JSON.parse(text)));
    const usage = normalizeUsageTotals(
      payload.usageMetadata?.promptTokenCount ?? Math.max(1, Math.ceil(promptTransport.promptChars / 4)),
      payload.usageMetadata?.candidatesTokenCount ?? 0,
      payload.usageMetadata?.totalTokenCount !== undefined
        ? {
            totalTokens: payload.usageMetadata.totalTokenCount,
          }
        : undefined,
    );

    return {
      object: parsed,
      model: payload.modelVersion ?? this.config.model,
      promptChars: promptTransport.promptChars,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cachedInputTokens: usage.cachedInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      contextWindowTokens: this.resolveContextWindowTokens(),
      estimatedCostUsd: 0,
    };
  }

  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) {
      return { ok: false, message: "GEMINI_API_KEY is not configured." };
    }
    try {
      const response = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(stripModelsPrefix(this.config.model))}?key=${encodeURIComponent(this.apiKey)}`,
      );
      if (!response.ok) {
        return {
          ok: false,
          message: `Gemini health check failed (${response.status}): ${await safeReadText(response)}`,
        };
      }
      return {
        ok: true,
        message: `Gemini provider is reachable for model '${this.config.model}'.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `Gemini health check failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  private buildRequestBody<T>(
    promptTransport: ReturnType<typeof renderPromptEnvelopeForTransport>,
    role: LLMGenerateRequest["role"],
    schema?: z.ZodType<T>,
  ): Record<string, unknown> {
    const transportSchema = schema ? buildTransportSchema(schema, `${role}_response`, "Gemini") : undefined;
    return {
      systemInstruction: {
        parts: [{ text: `${promptTransport.instructions}\n\nReturn only valid JSON that matches the provided schema.` }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: promptTransport.inputText }],
        },
      ],
      ...(transportSchema
        ? {
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: transportSchema.schema,
            },
          }
        : {}),
    };
  }

  private resolveContextWindowTokens(): number {
    const resolved = this.config.contextWindowTokens ?? resolveBuiltInContextWindow(this.config.provider, this.config.model);
    if (resolved === undefined) {
      throw new AppError("CONFIG_ERROR", `Context window is unknown for model '${this.config.model}'.`, {
        details: { provider: this.config.provider, model: this.config.model },
      });
    }
    return resolved;
  }

  private async fetchWithRetry(
    path: string,
    body: string,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: stream ? "text/event-stream" : "application/json",
          },
          body,
          ...(signal ? { signal } : {}),
        });
        if (!response.ok && isRetryableStatus(response.status) && attempt < MAX_GENERATE_ATTEMPTS) {
          lastError = await safeReadText(response);
          await sleep(backoffForAttempt(attempt));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt >= MAX_GENERATE_ATTEMPTS || !isRetryableNetworkError(error)) {
          throw new AppError("LLM_ERROR", `Gemini API request failed: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error });
        }
        lastError = error;
        await sleep(backoffForAttempt(attempt));
      }
    }
    throw new AppError("LLM_ERROR", `Gemini API request failed: ${String(lastError ?? "unknown failure")}`);
  }

  private async consumeStreamedResponse(
    response: Response,
    stream: LLMGenerateRequest["stream"],
  ): Promise<z.infer<typeof GeminiResponseSchema>> {
    const body = response.body;
    if (!body) {
      throw new AppError("LLM_ERROR", "Gemini streaming response did not include a body.");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastPayload: z.infer<typeof GeminiResponseSchema> | undefined;

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replaceAll("\r", "");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = parseSseFrame(frame);
        if (payload === undefined) {
          continue;
        }
        await stream?.onEvent?.({ type: "response.delta", data: payload });
        lastPayload = GeminiResponseSchema.parse(payload);
        const text = lastPayload.candidates[0]?.content?.parts.map((part) => part.text ?? "").join("") ?? "";
        if (text.length > 0) {
          await stream?.onTextDelta?.(text);
        }
      }
      if (done) {
        break;
      }
    }

    if (!lastPayload) {
      throw new AppError("LLM_ERROR", "Gemini streaming response ended without a candidate payload.");
    }
    return lastPayload;
  }
}

function stripModelsPrefix(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function parseSseFrame(frame: string): unknown {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) {
    return undefined;
  }
  return parsePossibleJson(dataLines.join("\n"));
}
