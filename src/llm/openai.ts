import { z } from "zod";

import { AppError } from "../errors.js";
import type { LLMClient, LLMGenerateRequest, LLMGenerateResponse, LLMStreamCallbacks } from "./client.js";
import { zodToJsonSchema } from "./json-schema.js";
import { renderPromptEnvelopeForTransport } from "./prompts.js";
import type { ResolvedLLMConfig } from "./routing.js";

type JsonSchema = Record<string, unknown>;
const MAX_GENERATE_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 520, 522, 524]);

const OpenAIResponseEnvelopeSchema = z.object({
  model: z.string().optional(),
  output_text: z.string().optional(),
  output: z
    .array(
      z.object({
        content: z
          .array(
            z.object({
              text: z.string().optional(),
              json: z.unknown().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export class OpenAIResponsesClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  public constructor(private readonly config: ResolvedLLMConfig, env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = env.OPENAI_API_KEY;
  }

  public async generateObject<T>(
    request: LLMGenerateRequest,
    schema: z.ZodType<T>,
  ): Promise<LLMGenerateResponse<T>> {
    if (!this.apiKey) {
      throw new AppError("CONFIG_ERROR", "OPENAI_API_KEY is required when llmProvider is 'openai'.");
    }

    const formatSchemaName = `${request.role}_response`;
    const transportSchema = buildTransportSchema(schema, formatSchemaName);
    const shouldStream = request.stream !== undefined;
    const promptTransport = renderPromptEnvelopeForTransport(request.prompt, request.input);
    const requestBody = JSON.stringify({
      model: this.config.model,
      instructions: `${promptTransport.instructions}\n\nReturn only valid JSON that matches the provided schema.`,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: promptTransport.inputText,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: formatSchemaName,
          schema: transportSchema.schema,
          strict: true,
        },
      },
      ...(shouldStream ? { stream: true } : {}),
    });

    const response = await this.fetchWithRetry(requestBody, shouldStream);

    if (!response.ok) {
      const message = await safeReadText(response);
      throw new AppError("LLM_ERROR", formatOpenAIErrorMessage(response.status, message));
    }

    const payload = shouldStream ? await this.consumeStreamedResponse(response, request.stream) : OpenAIResponseEnvelopeSchema.parse(await response.json());
    const raw = extractStructuredText(payload);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new AppError("LLM_ERROR", "OpenAI response did not contain valid JSON.", { cause: error });
    }

    const parsed = schema.parse(transportSchema.unwrap(parsedJson));
    return {
      object: parsed,
      model: payload.model ?? this.config.model,
      promptChars: promptTransport.promptChars,
      estimatedCostUsd: 0,
    };
  }

  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: "OPENAI_API_KEY is not configured.",
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/models/${encodeURIComponent(this.config.model)}`, {
        method: "GET",
        headers: this.buildHeaders(false),
      });
      if (!response.ok) {
        const message = await safeReadText(response);
        return {
          ok: false,
          message: `OpenAI health check failed (${response.status}): ${message}`,
        };
      }
      return {
        ok: true,
        message: `OpenAI provider is reachable for model '${this.config.model}'.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `OpenAI health check failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  private buildHeaders(stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${this.apiKey ?? ""}`,
    };
    if (this.config.organization) {
      headers["OpenAI-Organization"] = this.config.organization;
    }
    if (this.config.project) {
      headers["OpenAI-Project"] = this.config.project;
    }
    return headers;
  }

  private async fetchWithRetry(body: string, stream: boolean): Promise<Response> {
    let lastFailure:
      | {
          kind: "response";
          status: number;
          message: string;
        }
      | {
          kind: "network";
          error: unknown;
        }
      | undefined;

    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: this.buildHeaders(stream),
          body,
        });
        if (!response.ok && isRetryableStatus(response.status) && attempt < MAX_GENERATE_ATTEMPTS) {
          lastFailure = {
            kind: "response",
            status: response.status,
            message: await safeReadText(response),
          };
          await sleep(backoffForAttempt(attempt));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt >= MAX_GENERATE_ATTEMPTS || !isRetryableNetworkError(error)) {
          throw new AppError("LLM_ERROR", buildNetworkFailureMessage(error), { cause: error });
        }
        lastFailure = {
          kind: "network",
          error,
        };
        await sleep(backoffForAttempt(attempt));
      }
    }

    if (lastFailure?.kind === "response") {
      throw new AppError("LLM_ERROR", formatOpenAIErrorMessage(lastFailure.status, lastFailure.message));
    }
    if (lastFailure?.kind === "network") {
      throw new AppError("LLM_ERROR", buildNetworkFailureMessage(lastFailure.error), { cause: lastFailure.error });
    }
    throw new AppError("LLM_ERROR", "OpenAI Responses API failed before any response was received.");
  }

  private async consumeStreamedResponse(
    response: Response,
    stream: LLMStreamCallbacks | undefined,
  ): Promise<z.infer<typeof OpenAIResponseEnvelopeSchema>> {
    const body = response.body;
    if (!body) {
      throw new AppError("LLM_ERROR", "OpenAI streaming response did not include a body.");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedText = "";
    let completedPayload: unknown;
    let failureMessage: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r", "");
      while (true) {
        const separator = buffer.indexOf("\n\n");
        if (separator === -1) {
          break;
        }
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const outcome = await processSSEFrame(frame, stream);
        if (typeof outcome.delta === "string" && outcome.delta.length > 0) {
          accumulatedText += outcome.delta;
        }
        if (outcome.completedPayload !== undefined) {
          completedPayload = outcome.completedPayload;
        }
        if (typeof outcome.failureMessage === "string") {
          failureMessage = outcome.failureMessage;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const outcome = await processSSEFrame(buffer, stream);
      if (typeof outcome.delta === "string" && outcome.delta.length > 0) {
        accumulatedText += outcome.delta;
      }
      if (outcome.completedPayload !== undefined) {
        completedPayload = outcome.completedPayload;
      }
      if (typeof outcome.failureMessage === "string") {
        failureMessage = outcome.failureMessage;
      }
    }

    if (failureMessage) {
      throw new AppError("LLM_ERROR", failureMessage);
    }

    if (completedPayload !== undefined) {
      return OpenAIResponseEnvelopeSchema.parse(completedPayload);
    }

    if (accumulatedText.trim().length > 0) {
      return OpenAIResponseEnvelopeSchema.parse({
        model: this.config.model,
        output_text: accumulatedText,
      });
    }

    throw new AppError("LLM_ERROR", "OpenAI streaming response ended without a completed payload or output text.");
  }
}

function buildTransportSchema<T>(
  schema: z.ZodType<T>,
  name: string,
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
        throw new AppError("LLM_ERROR", "OpenAI response did not match the wrapped structured output shape.");
      }
      return (value as { data: unknown }).data;
    },
  };
}

function extractStructuredText(payload: z.infer<typeof OpenAIResponseEnvelopeSchema>): string {
  if (payload.output_text && payload.output_text.trim().length > 0) {
    return payload.output_text;
  }
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.trim().length > 0) {
        return content.text;
      }
      if (content.json !== undefined) {
        return JSON.stringify(content.json);
      }
    }
  }
  throw new AppError("LLM_ERROR", "OpenAI response did not include structured output text.");
}

async function processSSEFrame(
  frame: string,
  stream: LLMStreamCallbacks | undefined,
): Promise<{
  delta?: string;
  completedPayload?: unknown;
  failureMessage?: string;
}> {
  let eventType = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      eventType = value;
      continue;
    }
    if (field === "data") {
      dataLines.push(value);
    }
  }

  const rawData = dataLines.join("\n");
  if (rawData === "[DONE]") {
    await stream?.onEvent?.({ type: eventType, data: "[DONE]" });
    return {};
  }

  const parsedData = rawData.length > 0 ? parsePossibleJson(rawData) : undefined;
  await stream?.onEvent?.({ type: eventType, data: parsedData });

  if (eventType === "response.output_text.delta") {
    const delta = extractDeltaText(parsedData);
    if (delta.length > 0) {
      await stream?.onTextDelta?.(delta);
      return { delta };
    }
    return {};
  }

  if (eventType === "response.completed") {
    return {
      completedPayload: extractCompletedPayload(parsedData),
    };
  }

  if (eventType === "response.failed" || eventType === "error") {
    return {
      failureMessage: formatStreamFailure(eventType, parsedData),
    };
  }

  return {};
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 0 ? text : response.statusText;
  } catch {
    return response.statusText;
  }
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

function buildNetworkFailureMessage(error: unknown): string {
  return `OpenAI Responses API request failed before a response was received: ${error instanceof Error ? error.message : "unknown error"}`;
}

function formatOpenAIErrorMessage(status: number, body: string): string {
  if (looksLikeHtml(body)) {
    const upstream = status >= 500 ? "upstream transient failure" : "unexpected HTML error page";
    return `OpenAI Responses API failed (${status}): ${upstream}.`;
  }
  return `OpenAI Responses API failed (${status}): ${body}`;
}

function looksLikeHtml(value: string): boolean {
  const sample = value.trim().slice(0, 256).toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html");
}

function backoffForAttempt(attempt: number): number {
  return attempt * attempt * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePossibleJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractDeltaText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "delta" in value && typeof value.delta === "string") {
    return value.delta;
  }
  return "";
}

function extractCompletedPayload(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "response" in value) {
    return (value as { response: unknown }).response;
  }
  return value;
}

function formatStreamFailure(eventType: string, value: unknown): string {
  if (typeof value === "object" && value !== null) {
    if ("error" in value && typeof value.error === "object" && value.error !== null && "message" in value.error) {
      const error = value.error as { message?: unknown };
      if (typeof error.message === "string" && error.message.length > 0) {
        return `OpenAI streaming failed during ${eventType}: ${error.message}`;
      }
    }
    if ("message" in value && typeof value.message === "string" && value.message.length > 0) {
      return `OpenAI streaming failed during ${eventType}: ${value.message}`;
    }
  }
  if (typeof value === "string" && value.length > 0) {
    return `OpenAI streaming failed during ${eventType}: ${value}`;
  }
  return `OpenAI streaming failed during ${eventType}.`;
}
