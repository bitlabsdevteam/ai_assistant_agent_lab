import type { LLMProvider, Settings } from "../schemas.js";
import type { LLMGenerateRequest } from "./client.js";
import { resolveBuiltInContextWindow as resolveBuiltInContextWindowByProvider } from "./capabilities.js";

export interface ResolvedLLMConfig {
  provider: LLMProvider;
  model: string;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  project?: string | undefined;
  contextWindowTokens?: number | undefined;
}

export type LLMRole = LLMGenerateRequest["role"];

const ROLES: LLMRole[] = ["analyzer", "executor", "evaluator"];

export function resolveLLMConfigForRole(settings: Settings, role: LLMRole): ResolvedLLMConfig {
  const override = settings.llmRouting[role];
  const provider = override?.provider ?? settings.llmProvider;
  const model = override?.model ?? settings.llmModel;
  return {
    provider,
    model,
    baseUrl: override?.baseUrl ?? settings.llmBaseUrl,
    organization: override?.organization ?? settings.llmOrganization,
    project: override?.project ?? settings.llmProject,
    contextWindowTokens: resolveConfiguredContextWindow(settings, provider, model),
  };
}

export function listResolvedLLMConfigs(
  settings: Settings,
): Array<{
  role: LLMRole;
  config: ResolvedLLMConfig;
}> {
  return ROLES.map((role) => ({
    role,
    config: resolveLLMConfigForRole(settings, role),
  }));
}

export function resolveConfiguredContextWindow(
  settings: Settings,
  provider: LLMProvider,
  model: string,
): number | undefined {
  return settings.llmContextWindows[`${provider}:${model}`] ?? settings.llmContextWindows[model] ?? resolveBuiltInContextWindow(provider, model);
}

export function resolveBuiltInContextWindow(provider: LLMProvider, model: string): number | undefined {
  return resolveBuiltInContextWindowByProvider(provider, model);
}
