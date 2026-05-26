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

const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";

const MoonshotResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({
          cached_tokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
      completion_tokens_details: z
        .object({
          reasoning_tokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

export class MoonshotClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  public constructor(private readonly config: ResolvedLLMConfig, env: NodeJS.ProcessEnv = process.env) {
    assertStructuredOutputSupport(config);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = env.MOONSHOT_API_KEY;
  }

  public async countTokens<T>(request: LLMGenerateRequest, schema?: z.ZodType<T>): Promise<LLMTokenCount> {
    const promptTransport = renderPromptEnvelopeForTransport(request.prompt, request.input);
    const body = this.buildRequestBody(promptTransport, request.role, schema, false);
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
      throw new AppError("CONFIG_ERROR", "MOONSHOT_API_KEY is required when llmProvider is 'moonshot'.");
    }
    const promptTransport = renderPromptEnvelopeForTransport(request.prompt, request.input);
    const shouldStream = request.stream !== undefined;
    const response = await this.fetchWithRetry(
      JSON.stringify(this.buildRequestBody(promptTransport, request.role, schema, shouldStream)),
      shouldStream,
      request.signal,
    );
    if (!response.ok) {
      throw new AppError("LLM_ERROR", `Moonshot API failed (${response.status}): ${await safeReadText(response)}`);
    }
    const payload = shouldStream
      ? await this.consumeStreamedResponse(response, request.stream)
      : MoonshotResponseSchema.parse(await response.json());
    const raw = payload.choices[0]?.message?.content?.trim();
    if (!raw) {
      throw new AppError("LLM_ERROR", "Moonshot response did not include structured JSON content.");
    }
    const transportSchema = buildTransportSchema(schema, `${request.role}_response`, "Moonshot");
    const parsed = schema.parse(transportSchema.unwrap(JSON.parse(raw)));
    const usage = normalizeUsageTotals(
      payload.usage?.prompt_tokens ?? Math.max(1, Math.ceil(promptTransport.promptChars / 4)),
      payload.usage?.completion_tokens ?? 0,
      {
        ...(payload.usage?.total_tokens !== undefined ? { totalTokens: payload.usage.total_tokens } : {}),
        ...(payload.usage?.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: payload.usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(payload.usage?.completion_tokens_details?.reasoning_tokens !== undefined
          ? { reasoningOutputTokens: payload.usage.completion_tokens_details.reasoning_tokens }
          : {}),
      },
    );
    return {
      object: parsed,
      model: payload.model ?? this.config.model,
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
      return { ok: false, message: "MOONSHOT_API_KEY is not configured." };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.buildHeaders(false),
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `Moonshot health check failed (${response.status}): ${await safeReadText(response)}`,
        };
      }
      return {
        ok: true,
        message: `Moonshot provider is reachable for model '${this.config.model}'.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `Moonshot health check failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  private buildHeaders(stream: boolean): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${this.apiKey ?? ""}`,
    };
  }

  private buildRequestBody<T>(
    promptTransport: ReturnType<typeof renderPromptEnvelopeForTransport>,
    role: LLMGenerateRequest["role"],
    schema: z.ZodType<T> | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const transportSchema = schema ? buildTransportSchema(schema, `${role}_response`, "Moonshot") : undefined;
    return {
      model: this.config.model,
      stream,
      messages: [
        {
          role: "system",
          content: `${promptTransport.instructions}\n\nReturn only valid JSON that matches the provided schema.`,
        },
        {
          role: "user",
          content: promptTransport.inputText,
        },
      ],
      ...(transportSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: `${role}_response`,
                strict: true,
                schema: transportSchema.schema,
              },
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

  private async fetchWithRetry(body: string, stream: boolean, signal?: AbortSignal): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.buildHeaders(stream),
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
          throw new AppError("LLM_ERROR", `Moonshot API request failed: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error });
        }
        lastError = error;
        await sleep(backoffForAttempt(attempt));
      }
    }
    throw new AppError("LLM_ERROR", `Moonshot API request failed: ${String(lastError ?? "unknown failure")}`);
  }

  private async consumeStreamedResponse(
    response: Response,
    stream: LLMGenerateRequest["stream"],
  ): Promise<z.infer<typeof MoonshotResponseSchema>> {
    const body = response.body;
    if (!body) {
      throw new AppError("LLM_ERROR", "Moonshot streaming response did not include a body.");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: z.infer<typeof MoonshotResponseSchema>["usage"];

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replaceAll("\r", "");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (parsed === undefined) {
          continue;
        }
        await stream?.onEvent?.({ type: "response.delta", data: parsed });
        const chunk = MoonshotStreamChunkSchema.parse(parsed);
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta.length > 0) {
          content += delta;
          await stream?.onTextDelta?.(delta);
        }
        usage = chunk.usage ?? usage;
      }
      if (done) {
        break;
      }
    }

    return MoonshotResponseSchema.parse({
      model: this.config.model,
      choices: [{ message: { content } }],
      usage,
    });
  }
}

const MoonshotStreamChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  usage: MoonshotResponseSchema.shape.usage.optional(),
});

function parseSseFrame(frame: string): unknown {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) {
    return undefined;
  }
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") {
    return undefined;
  }
  return parsePossibleJson(raw);
}
