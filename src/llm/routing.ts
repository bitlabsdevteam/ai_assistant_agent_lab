import type { Settings } from "../schemas.js";
import type { LLMGenerateRequest } from "./client.js";

export interface ResolvedLLMConfig {
  provider: string;
  model: string;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  project?: string | undefined;
  contextWindowTokens?: number | undefined;
}

export type LLMRole = LLMGenerateRequest["role"];

const ROLES: LLMRole[] = ["analyzer", "executor", "evaluator"];
const BUILTIN_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.4-test": 128_000,
};

export function resolveLLMConfigForRole(settings: Settings, role: LLMRole): ResolvedLLMConfig {
  const override = settings.llmRouting[role];
  const model = override?.model ?? settings.llmModel;
  return {
    provider: override?.provider ?? settings.llmProvider,
    model,
    baseUrl: override?.baseUrl ?? settings.llmBaseUrl,
    organization: override?.organization ?? settings.llmOrganization,
    project: override?.project ?? settings.llmProject,
    contextWindowTokens: resolveConfiguredContextWindow(settings, model),
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

export function resolveConfiguredContextWindow(settings: Settings, model: string): number | undefined {
  return settings.llmContextWindows[model] ?? BUILTIN_CONTEXT_WINDOWS[model];
}

export function resolveBuiltInContextWindow(model: string): number | undefined {
  return BUILTIN_CONTEXT_WINDOWS[model];
}
