import { z } from "zod";

import { AppError } from "../errors.js";
import type { LLMClient, LLMGenerateRequest, LLMGenerateResponse } from "./client.js";
import { zodToJsonSchema } from "./json-schema.js";
import type { ResolvedLLMConfig } from "./routing.js";

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

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model: this.config.model,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: `You are the ${request.role} agent in little-helper. Return only valid JSON that matches the provided schema.`,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: request.prompt,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: `${request.role}_response`,
            schema: zodToJsonSchema(schema, `${request.role}_response`),
            strict: true,
          },
        },
      }),
    });

    if (!response.ok) {
      const message = await safeReadText(response);
      throw new AppError("LLM_ERROR", `OpenAI Responses API failed (${response.status}): ${message}`);
    }

    const payload = OpenAIResponseEnvelopeSchema.parse(await response.json());
    const raw = extractStructuredText(payload);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new AppError("LLM_ERROR", "OpenAI response did not contain valid JSON.", { cause: error });
    }

    const parsed = schema.parse(parsedJson);
    return {
      object: parsed,
      model: payload.model ?? this.config.model,
      promptChars: request.prompt.length,
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
        headers: this.buildHeaders(),
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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
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

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 0 ? text : response.statusText;
  } catch {
    return response.statusText;
  }
}
