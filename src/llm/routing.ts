import type { Settings } from "../schemas.js";
import type { LLMGenerateRequest } from "./client.js";

export interface ResolvedLLMConfig {
  provider: string;
  model: string;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  project?: string | undefined;
}

export type LLMRole = LLMGenerateRequest["role"];

const ROLES: LLMRole[] = ["analyzer", "executor", "evaluator"];

export function resolveLLMConfigForRole(settings: Settings, role: LLMRole): ResolvedLLMConfig {
  const override = settings.llmRouting[role];
  return {
    provider: override?.provider ?? settings.llmProvider,
    model: override?.model ?? settings.llmModel,
    baseUrl: override?.baseUrl ?? settings.llmBaseUrl,
    organization: override?.organization ?? settings.llmOrganization,
    project: override?.project ?? settings.llmProject,
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
