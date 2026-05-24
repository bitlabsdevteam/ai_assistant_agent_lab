import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { AppError } from "./errors.js";
import { listResolvedLLMConfigs } from "./llm/routing.js";
import { SettingsSchema, type ApprovalMode, type OutputFormat, type Settings } from "./schemas.js";

const PartialSettingsSchema = SettingsSchema.partial();

export interface CliOverrides {
  artifactDir?: string;
  approvalMode?: ApprovalMode;
  cwd?: string;
  maxIterations?: number;
  outputFormat?: OutputFormat;
  stream?: boolean;
}

async function readJsonFileIfExists(filePath: string): Promise<Record<string, unknown>> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    return {};
  }

  try {
    const raw = await readFile(filePath, "utf8");
    return z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
  } catch (error) {
    throw new AppError("CONFIG_ERROR", `Invalid config file: ${filePath}`, {
      cause: error,
      details: { filePath },
    });
  }
}

function parseEnvSettings(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    env: env.LITTLE_HELPER_ENV,
    logLevel: env.LITTLE_HELPER_LOG_LEVEL,
    artifactDir: env.LITTLE_HELPER_ARTIFACT_DIR,
    llmProvider: env.LITTLE_HELPER_LLM_PROVIDER,
    llmModel: env.LITTLE_HELPER_LLM_MODEL,
    llmBaseUrl: env.LITTLE_HELPER_LLM_BASE_URL,
    llmOrganization: env.LITTLE_HELPER_LLM_ORGANIZATION,
    llmProject: env.LITTLE_HELPER_LLM_PROJECT,
    maxIterations: env.LITTLE_HELPER_MAX_ITERATIONS ? Number(env.LITTLE_HELPER_MAX_ITERATIONS) : undefined,
    approvalMode: env.LITTLE_HELPER_APPROVAL_MODE,
  };
}

export async function loadSettings(
  workingDirectory: string,
  overrides: CliOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Settings> {
  const projectConfigPath = path.join(workingDirectory, ".little-helper.config.json");
  const userConfigPath = path.join(homedir(), ".config", "little-helper", "config.json");

  const defaults: Record<string, unknown> = {
    allowedRoots: [workingDirectory],
  };
  const projectConfig = await readJsonFileIfExists(projectConfigPath);
  const userConfig = await readJsonFileIfExists(userConfigPath);
  const envConfig = parseEnvSettings(env);
  const cliConfig: Record<string, unknown> = {
    artifactDir: overrides.artifactDir,
    approvalMode: overrides.approvalMode,
    maxIterations: overrides.maxIterations,
    outputFormat: overrides.outputFormat,
    stream: overrides.stream,
  };

  const merged = {
    ...defaults,
    ...projectConfig,
    ...userConfig,
    ...envConfig,
    ...cliConfig,
  };

  const parsed = PartialSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new AppError("CONFIG_ERROR", "Invalid settings", {
      details: { issues: parsed.error.flatten() },
    });
  }

  const settings = SettingsSchema.parse({
    ...parsed.data,
    artifactDir: resolveArtifactDir(workingDirectory, parsed.data.artifactDir),
    allowedRoots: normalizeRoots(workingDirectory, parsed.data.allowedRoots),
  });

  validateProductionSettings(settings, env);
  return settings;
}

function resolveArtifactDir(workingDirectory: string, artifactDir?: string): string {
  const value = artifactDir ?? ".little-helper/runs";
  return path.isAbsolute(value) ? value : path.join(workingDirectory, value);
}

function normalizeRoots(workingDirectory: string, roots?: string[]): string[] {
  const input = roots && roots.length > 0 ? roots : [workingDirectory];
  return [...new Set(input.map((item) => (path.isAbsolute(item) ? item : path.join(workingDirectory, item))))];
}

export function validateProductionSettings(settings: Settings, env: NodeJS.ProcessEnv = process.env): void {
  if (settings.env !== "production") {
    return;
  }
  for (const { role, config } of listResolvedLLMConfigs(settings)) {
    if (config.provider === "mock") {
      throw new AppError("CONFIG_ERROR", `Production mode requires a non-mock LLM provider for role '${role}'.`);
    }
    if (config.provider === "openai" && !env.OPENAI_API_KEY) {
      throw new AppError(
        "CONFIG_ERROR",
        `Production mode with llmProvider 'openai' requires OPENAI_API_KEY for role '${role}'.`,
      );
    }
  }
  if (settings.approvalMode === "always" && !settings.stream) {
    throw new AppError("CONFIG_ERROR", "Approval mode 'always' requires streaming or an external approval workflow.");
  }
}
