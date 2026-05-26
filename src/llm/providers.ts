import type { z } from "zod";

import { AppError } from "../errors.js";
import type { Settings } from "../schemas.js";
import type { LLMClient, LLMGenerateRequest, LLMGenerateResponse } from "./client.js";
import { AnthropicClient } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";
import { MoonshotClient } from "./moonshot.js";
import { OpenAIResponsesClient } from "./openai.js";
import { listResolvedLLMConfigs, resolveLLMConfigForRole, type ResolvedLLMConfig } from "./routing.js";
import type { LLMTokenCount } from "../schemas.js";

export class UnsupportedLLMClient implements LLMClient {
  public constructor(private readonly provider: string, private readonly model: string) {}

  public generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>> {
    void request;
    void schema;
    return Promise.reject(
      new AppError(
        "LLM_ERROR",
        `Provider '${this.provider}' is configured but no adapter is implemented yet for model '${this.model}'.`,
      ),
    );
  }

  public countTokens<T>(_request: LLMGenerateRequest, _schema?: z.ZodType<T>): Promise<LLMTokenCount> {
    return Promise.reject(
      new AppError(
        "LLM_ERROR",
        `Provider '${this.provider}' is configured but no adapter is implemented yet for model '${this.model}'.`,
      ),
    );
  }

  public healthCheck(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({
      ok: false,
      message: `Provider '${this.provider}' is not implemented in this build.`,
    });
  }
}

export class RoutedLLMClient implements LLMClient {
  private readonly clients = new Map<string, LLMClient>();

  public constructor(
    private readonly settings: Settings,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  public countTokens<T>(request: LLMGenerateRequest, schema?: z.ZodType<T>): Promise<LLMTokenCount> {
    return this.getClientForRole(request.role).countTokens(request, schema);
  }

  public generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>> {
    return this.getClientForRole(request.role).generateObject(request, schema);
  }

  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const resolved = listResolvedLLMConfigs(this.settings);
    const uniqueByKey = new Map<string, { roles: string[]; config: ResolvedLLMConfig }>();
    for (const item of resolved) {
      const key = stableConfigKey(item.config);
      const existing = uniqueByKey.get(key);
      if (existing) {
        existing.roles.push(item.role);
        continue;
      }
      uniqueByKey.set(key, {
        roles: [item.role],
        config: item.config,
      });
    }

    if (uniqueByKey.size === 1) {
      const only = uniqueByKey.values().next().value;
      if (!only) {
        return { ok: false, message: "No LLM routes configured." };
      }
      return this.getClientForConfig(only.config).healthCheck();
    }

    const results = await Promise.all(
      [...uniqueByKey.values()].map(async (item) => ({
        roles: item.roles,
        result: await this.getClientForConfig(item.config).healthCheck(),
      })),
    );

    return {
      ok: results.every((item) => item.result.ok),
      message: results
        .map((item) => `${item.roles.join(",")}: ${item.result.message}`)
        .join(" | "),
    };
  }

  private getClientForRole(role: LLMGenerateRequest["role"]): LLMClient {
    return this.getClientForConfig(resolveLLMConfigForRole(this.settings, role));
  }

  private getClientForConfig(config: ResolvedLLMConfig): LLMClient {
    const key = stableConfigKey(config);
    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }
    const client = createProviderClient(config, this.env);
    this.clients.set(key, client);
    return client;
  }
}

export function createLLMClient(settings: Settings, env: NodeJS.ProcessEnv = process.env): LLMClient {
  return new RoutedLLMClient(settings, env);
}

function createProviderClient(config: ResolvedLLMConfig, env: NodeJS.ProcessEnv): LLMClient {
  switch (config.provider) {
    case "openai":
      return new OpenAIResponsesClient(config, env);
    case "anthropic":
      return new AnthropicClient(config, env);
    case "gemini":
      return new GeminiClient(config, env);
    case "moonshot":
      return new MoonshotClient(config, env);
  }
  return new UnsupportedLLMClient(config.provider, config.model);
}

function stableConfigKey(config: ResolvedLLMConfig): string {
  return JSON.stringify({
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.organization ? { organization: config.organization } : {}),
    ...(config.project ? { project: config.project } : {}),
  });
}
