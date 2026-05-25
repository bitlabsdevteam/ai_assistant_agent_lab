import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export async function loadWorkspaceEnv(
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const dotEnv = await readDotEnvFile(path.join(workingDirectory, ".env"));
  return {
    ...dotEnv,
    ...env,
  };
}

export async function resolveWorkspaceEnvValue(
  key: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const resolved = await loadWorkspaceEnv(workingDirectory, env);
  const value = resolved[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function applyWorkspaceEnvToProcess(
  workingDirectory: string,
  targetEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const resolved = await loadWorkspaceEnv(workingDirectory, targetEnv);
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== "string" || targetEnv[key] !== undefined) {
      continue;
    }
    targetEnv[key] = value;
  }
  return resolved;
}

async function readDotEnvFile(filePath: string): Promise<NodeJS.ProcessEnv> {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    return {};
  }

  const raw = await readFile(filePath, "utf8");
  const parsed: NodeJS.ProcessEnv = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    const value = normalized.slice(separator + 1).trim();
    parsed[key] = parseEnvValue(value);
  }
  return parsed;
}

function parseEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  if (commentIndex >= 0) {
    return value.slice(0, commentIndex).trimEnd();
  }
  return value;
}
