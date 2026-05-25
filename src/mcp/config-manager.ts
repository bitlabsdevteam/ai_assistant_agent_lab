import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { AppError } from "../errors.js";
import { MCPServerConfigSchema, type MCPDiscovery, type MCPServerConfig, type Settings } from "../schemas.js";
import { MCPClient } from "./client.js";

export const MCPConfigScopeSchema = z.enum(["project", "user"]);

export type MCPConfigScope = z.infer<typeof MCPConfigScopeSchema>;

export interface AddMCPServerConfigInput {
  workingDirectory: string;
  scope: MCPConfigScope;
  server: MCPServerConfig;
  settings: Settings;
}

export interface AddMCPServerConfigResult {
  scope: MCPConfigScope;
  configPath: string;
  server: MCPServerConfig;
  discovery: MCPDiscovery;
}

interface ConfigManagerDependencies {
  discoverServer?: (server: MCPServerConfig) => Promise<MCPDiscovery>;
  homeDirectory?: string;
}

const ConfigDocumentSchema = z.record(z.string(), z.unknown());

export async function addMCPServerConfig(
  input: AddMCPServerConfigInput,
  dependencies: ConfigManagerDependencies = {},
): Promise<AddMCPServerConfigResult> {
  const configPath = resolveMCPConfigPath(input.scope, input.workingDirectory, dependencies.homeDirectory);
  const document = await readConfigDocument(configPath);
  const existingServers = parseConfiguredServers(document, configPath);

  if (existingServers.some((server) => server.name === input.server.name)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MCP server '${input.server.name}' already exists in ${input.scope} config.`,
      {
        details: { configPath, serverName: input.server.name },
      },
    );
  }

  const discoveryClient =
    dependencies.discoverServer ??
    ((server: MCPServerConfig) => new MCPClient({ ...input.settings, mcpServers: [server] }).discoverServer(server));
  const discovery = await discoveryClient(input.server);
  if (discovery.status !== "ready") {
    throw new AppError("TOOL_ERROR", `MCP discovery failed for '${input.server.name}': ${discovery.error ?? "Unknown error"}.`, {
      details: { configPath, serverName: input.server.name },
    });
  }

  const nextDocument = {
    ...document,
    mcpServers: [...existingServers, input.server],
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextDocument, null, 2)}\n`, "utf8");

  return {
    scope: input.scope,
    configPath,
    server: input.server,
    discovery,
  };
}

export function resolveMCPConfigPath(scope: MCPConfigScope, workingDirectory: string, homeDirectory = homedir()): string {
  if (scope === "project") {
    return path.join(workingDirectory, ".little-helper.config.json");
  }
  return path.join(homeDirectory, ".config", "little-helper", "config.json");
}

export function mergeMCPServerConfigs(...sources: Array<unknown>): MCPServerConfig[] {
  const merged = new Map<string, MCPServerConfig>();

  for (const source of sources) {
    if (source === undefined) {
      continue;
    }
    const servers = z.array(MCPServerConfigSchema).parse(source);
    for (const server of servers) {
      merged.set(server.name, server);
    }
  }

  return [...merged.values()];
}

async function readConfigDocument(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    return ConfigDocumentSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw new AppError("CONFIG_ERROR", `Invalid config file: ${configPath}`, {
      cause: error,
      details: { configPath },
    });
  }
}

function parseConfiguredServers(document: Record<string, unknown>, configPath: string): MCPServerConfig[] {
  if (document.mcpServers === undefined) {
    return [];
  }

  try {
    return z.array(MCPServerConfigSchema).parse(document.mcpServers);
  } catch (error) {
    throw new AppError("CONFIG_ERROR", `Invalid mcpServers in config file: ${configPath}`, {
      cause: error,
      details: { configPath },
    });
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
