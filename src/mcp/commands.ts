import { z } from "zod";

import { AppError } from "../errors.js";
import { MCPServerConfigSchema, type MCPDiscovery, type MCPServerConfig } from "../schemas.js";
import { MCPConfigScopeSchema, type AddMCPServerConfigResult, type MCPConfigScope } from "./config-manager.js";

const SupportedMCPTransportSchema = z.enum(["stdio", "http"]);

const RawMCPAddInputSchema = z.object({
  name: z.string().min(1),
  scope: MCPConfigScopeSchema.default("project"),
  transport: z.string().default("stdio"),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  url: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  allowedTools: z.array(z.string()).default([]),
  disabled: z.boolean().default(false),
});

export interface MCPAddCommandInput {
  name: string;
  scope: MCPConfigScope;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  timeoutMs: number;
  allowedTools: string[];
  disabled: boolean;
}

export function normalizeMCPAddInput(input: unknown): MCPAddCommandInput {
  const result = RawMCPAddInputSchema.safeParse(input);
  if (!result.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid MCP add arguments.", {
      details: { issues: result.error.flatten() },
    });
  }
  const parsed = result.data;

  if (parsed.transport === "sse") {
    throw new AppError("VALIDATION_ERROR", "MCP transport 'sse' is not supported by `mcp add` yet.");
  }

  const transportResult = SupportedMCPTransportSchema.safeParse(parsed.transport);
  if (!transportResult.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Unsupported MCP transport '${parsed.transport}'. Use 'stdio' or 'http'.`,
    );
  }

  if (transportResult.data === "stdio" && !parsed.command) {
    throw new AppError("VALIDATION_ERROR", "MCP stdio servers require `--command <cmd>`.");
  }

  if (transportResult.data === "http" && !parsed.url) {
    throw new AppError("VALIDATION_ERROR", "MCP HTTP servers require `--url <url>`.");
  }

  return {
    name: parsed.name,
    scope: parsed.scope,
    transport: transportResult.data,
    ...(parsed.command ? { command: parsed.command } : {}),
    args: parsed.args,
    ...(parsed.url ? { url: parsed.url } : {}),
    timeoutMs: parsed.timeoutMs,
    allowedTools: parsed.allowedTools,
    disabled: parsed.disabled,
  };
}

export function buildMCPServerConfig(input: MCPAddCommandInput): MCPServerConfig {
  const result = MCPServerConfigSchema.safeParse({
    name: input.name,
    transport: input.transport,
    ...(input.transport === "stdio" ? { command: input.command, args: input.args } : { url: input.url }),
    enabled: !input.disabled,
    timeoutMs: input.timeoutMs,
    allowedTools: input.allowedTools,
  });
  if (!result.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid MCP server configuration.", {
      details: { issues: result.error.flatten() },
    });
  }
  return result.data;
}

export function parseMCPAddArgv(argv: string[]): MCPAddCommandInput {
  if (argv.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Usage: /mcp add <name> [--scope <project|user>] [--transport <stdio|http>] [--command <cmd>] [--arg <value>] [--url <url>] [--timeout-ms <number>] [--allow-tool <toolName>] [--disabled]",
    );
  }

  const [name, ...rest] = argv;
  const state: Omit<MCPAddCommandInput, "name" | "transport" | "scope"> & {
    transport: string;
    scope: string;
  } = {
    scope: "project",
    transport: "stdio",
    args: [],
    timeoutMs: 30_000,
    allowedTools: [],
    disabled: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    switch (token) {
      case "--scope":
        state.scope = readFlagValue(rest, ++index, token);
        break;
      case "--transport":
        state.transport = readFlagValue(rest, ++index, token);
        break;
      case "--command":
        state.command = readFlagValue(rest, ++index, token);
        break;
      case "--arg":
        state.args.push(readFlagValue(rest, ++index, token));
        break;
      case "--url":
        state.url = readFlagValue(rest, ++index, token);
        break;
      case "--timeout-ms": {
        const value = readFlagValue(rest, ++index, token);
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new AppError("VALIDATION_ERROR", `Invalid value for --timeout-ms: ${value}`);
        }
        state.timeoutMs = parsed;
        break;
      }
      case "--allow-tool":
        state.allowedTools.push(readFlagValue(rest, ++index, token));
        break;
      case "--disabled":
        state.disabled = true;
        break;
      default:
        throw new AppError("VALIDATION_ERROR", `Unknown flag: ${token}`);
    }
  }

  return normalizeMCPAddInput({
    name,
    ...state,
  });
}

export function renderMCPAddResult(result: AddMCPServerConfigResult): string {
  return [
    `Saved MCP server '${result.server.name}' to ${result.scope} config.`,
    `path: ${result.configPath}`,
    `server: ${JSON.stringify(result.server)}`,
    `discovery: ${summarizeDiscovery(result.discovery)}`,
  ].join("\n");
}

export function renderMCPCommandHelp(): string {
  return [
    "/mcp",
    "/mcp list",
    "/mcp inspect <serverName>",
    "/mcp add <name> [--scope <project|user>] [--transport <stdio|http>] [--command <cmd>] [--arg <value>] [--url <url>] [--timeout-ms <number>] [--allow-tool <toolName>] [--disabled]",
  ].join("\n");
}

export function renderMCPDiscoveryList(discoveries: MCPDiscovery[]): string {
  if (discoveries.length === 0) {
    return "No MCP servers configured.";
  }

  return discoveries
    .map(
      (discovery) =>
        `${discovery.server} [${discovery.status}] transport=${discovery.transport} tools=${discovery.tools.map((tool) => tool.name).join(", ") || "none"} resources=${discovery.resources.length} templates=${discovery.resourceTemplates.length}`,
    )
    .join("\n");
}

export function renderMCPDiscovery(discovery: MCPDiscovery): string {
  return [
    `server: ${discovery.server}`,
    `status: ${discovery.status}`,
    `transport: ${discovery.transport}`,
    `tools: ${discovery.tools.map((tool) => tool.name).join(", ") || "none"}`,
    `resources: ${discovery.resources.length}`,
    `resourceTemplates: ${discovery.resourceTemplates.length}`,
    ...(discovery.error ? [`error: ${discovery.error}`] : []),
  ].join("\n");
}

export function summarizeDiscovery(discovery: MCPDiscovery): string {
  return [
    `status=${discovery.status}`,
    `tools=${discovery.tools.map((tool) => tool.name).join(", ") || "none"}`,
    `resources=${discovery.resources.length}`,
    `resourceTemplates=${discovery.resourceTemplates.length}`,
  ].join(" ");
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new AppError("VALIDATION_ERROR", `Missing value for ${flag}`);
  }
  return value;
}
