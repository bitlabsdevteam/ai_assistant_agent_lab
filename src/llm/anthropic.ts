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

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

const AnthropicMessageSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        input: z.unknown().optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class AnthropicClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  public constructor(private readonly config: ResolvedLLMConfig, env: NodeJS.ProcessEnv = process.env) {
    assertStructuredOutputSupport(config);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = env.ANTHROPIC_API_KEY;
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
      throw new AppError("CONFIG_ERROR", "ANTHROPIC_API_KEY is required when llmProvider is 'anthropic'.");
    }

    const promptTransport = renderPromptEnvelopeForTransport(request.prompt, request.input);
    const shouldStream = request.stream !== undefined;
    const requestBody = JSON.stringify({
      ...this.buildRequestBody(promptTransport, request.role, schema),
      ...(shouldStream ? { stream: true } : {}),
    });
    const response = await this.fetchWithRetry("/messages", requestBody, shouldStream, request.signal);
    if (!response.ok) {
      const message = await safeReadText(response);
      throw new AppError("LLM_ERROR", `Anthropic Messages API failed (${response.status}): ${message}`);
    }

    const payload = shouldStream
      ? await this.consumeStreamedResponse(response, request.stream)
      : AnthropicMessageSchema.parse(await response.json());
    const toolUse = payload.content.find((item) => item.type === "tool_use");
    if (!toolUse || toolUse.input === undefined) {
      throw new AppError("LLM_ERROR", "Anthropic response did not include a structured tool_use payload.");
    }
    const transportSchema = buildTransportSchema(schema, `${request.role}_response`, "Anthropic");
    const parsed = schema.parse(transportSchema.unwrap(toolUse.input));
    const usage = normalizeUsageTotals(
      payload.usage?.input_tokens ?? Math.max(1, Math.ceil(promptTransport.promptChars / 4)),
      payload.usage?.output_tokens ?? 0,
      {
        cachedInputTokens: (payload.usage?.cache_creation_input_tokens ?? 0) + (payload.usage?.cache_read_input_tokens ?? 0),
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
      return { ok: false, message: "ANTHROPIC_API_KEY is not configured." };
    }
    try {
      const response = await fetch(`${this.baseUrl}/messages/count_tokens`, {
        method: "POST",
        headers: this.buildHeaders(false),
        body: JSON.stringify({
          model: this.config.model,
          system: "health_check",
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `Anthropic health check failed (${response.status}): ${await safeReadText(response)}`,
        };
      }
      return {
        ok: true,
        message: `Anthropic provider is reachable for model '${this.config.model}'.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `Anthropic health check failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  private buildHeaders(stream: boolean): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": this.apiKey ?? "",
    };
  }

  private buildRequestBody<T>(
    promptTransport: ReturnType<typeof renderPromptEnvelopeForTransport>,
    role: LLMGenerateRequest["role"],
    schema?: z.ZodType<T>,
  ): Record<string, unknown> {
    const transportSchema = schema ? buildTransportSchema(schema, `${role}_response`, "Anthropic") : undefined;
    return {
      model: this.config.model,
      max_tokens: 4_096,
      system: `${promptTransport.instructions}\n\nReturn only the tool input that matches the provided schema.`,
      messages: [
        {
          role: "user",
          content: promptTransport.inputText,
        },
      ],
      ...(transportSchema
        ? {
            tools: [
              {
                name: `${role}_response`,
                description: "Strict structured output for Argus.",
                input_schema: transportSchema.schema,
              },
            ],
            tool_choice: {
              type: "tool",
              name: `${role}_response`,
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
          throw new AppError("LLM_ERROR", `Anthropic Messages API request failed: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error });
        }
        lastError = error;
        await sleep(backoffForAttempt(attempt));
      }
    }
    throw new AppError("LLM_ERROR", `Anthropic Messages API request failed: ${String(lastError ?? "unknown failure")}`);
  }

  private async consumeStreamedResponse(
    response: Response,
    stream: LLMGenerateRequest["stream"],
  ): Promise<z.infer<typeof AnthropicMessageSchema>> {
    const body = response.body;
    if (!body) {
      throw new AppError("LLM_ERROR", "Anthropic streaming response did not include a body.");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let model = this.config.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let partialJson = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replaceAll("\r", "");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (!parsed) {
          continue;
        }
        await stream?.onEvent?.({
          type: parsed.event,
          data: parsed.data,
        });
        if (parsed.event === "message_start" && typeof parsed.data === "object" && parsed.data !== null) {
          const message = (parsed.data as { message?: { model?: string; usage?: { input_tokens?: number } } }).message;
          model = message?.model ?? model;
          inputTokens = message?.usage?.input_tokens ?? inputTokens;
        }
        if (parsed.event === "content_block_delta" && typeof parsed.data === "object" && parsed.data !== null) {
          const delta = (parsed.data as { delta?: { partial_json?: string } }).delta?.partial_json ?? "";
          if (delta.length > 0) {
            partialJson += delta;
            await stream?.onTextDelta?.(delta);
          }
        }
        if (parsed.event === "message_delta" && typeof parsed.data === "object" && parsed.data !== null) {
          outputTokens = (parsed.data as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? outputTokens;
        }
        if (parsed.event === "error") {
          throw new AppError("LLM_ERROR", `Anthropic streaming failed: ${JSON.stringify(parsed.data)}`);
        }
      }
      if (done) {
        break;
      }
    }

    return AnthropicMessageSchema.parse({
      model,
      content: [
        {
          type: "tool_use",
          input: partialJson.length > 0 ? parsePossibleJson(partialJson) : {},
        },
      ],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    });
  }
}

function parseSseFrame(frame: string): { event: string; data: unknown } | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return {
    event,
    data: parsePossibleJson(dataLines.join("\n")),
  };
}
