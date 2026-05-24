import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { AppError } from "../errors.js";
import {
  MCPDiscoverySchema,
  MCPToolResultSchema,
  type MCPDiscovery,
  type MCPServerConfig,
  type MCPToolResult,
  type Settings,
} from "../schemas.js";

interface MCPRequest {
  id: string;
  method: "discover" | "invoke_tool" | "read_resource";
  params?: Record<string, unknown>;
}

interface MCPResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export class MCPClient {
  public constructor(private readonly settings: Settings) {}

  public async discoverAll(): Promise<MCPDiscovery[]> {
    const discoveries = await Promise.all(
      this.settings.mcpServers.filter((server) => server.enabled).map(async (server) => this.discoverServer(server)),
    );
    return discoveries.sort((left, right) => left.server.localeCompare(right.server));
  }

  public async discoverServer(server: MCPServerConfig): Promise<MCPDiscovery> {
    try {
      const result = await this.send(server, { id: randomUUID(), method: "discover" });
      return MCPDiscoverySchema.parse({
        server: server.name,
        transport: server.transport,
        status: "ready",
        ...toRecord(result),
      });
    } catch (error) {
      return MCPDiscoverySchema.parse({
        server: server.name,
        transport: server.transport,
        status: "failed",
        tools: [],
        resources: [],
        resourceTemplates: [],
        error: error instanceof Error ? error.message : "Unknown MCP discovery error",
      });
    }
  }

  public async invokeTool(server: MCPServerConfig, toolName: string, input: unknown): Promise<MCPToolResult> {
    const result = await this.send(server, {
      id: randomUUID(),
      method: "invoke_tool",
      params: {
        tool: toolName,
        input,
      },
    });
    return MCPToolResultSchema.parse({
      server: server.name,
      tool: toolName,
      result,
    });
  }

  public async readResource(server: MCPServerConfig, uri: string): Promise<{ server: string; uri: string; content: unknown }> {
    const result = await this.send(server, {
      id: randomUUID(),
      method: "read_resource",
      params: {
        uri,
      },
    });
    return {
      server: server.name,
      uri,
      content: result,
    };
  }

  private async send(server: MCPServerConfig, request: MCPRequest): Promise<unknown> {
    switch (server.transport) {
      case "stdio":
        return this.sendViaStdio(server, request);
      case "http":
        return this.sendViaHttp(server, request);
      case "sse":
        throw new AppError("LLM_ERROR", `SSE MCP transport is not implemented for server '${server.name}'.`);
    }
  }

  private async sendViaStdio(server: MCPServerConfig, request: MCPRequest): Promise<unknown> {
    if (!server.command) {
      throw new AppError("CONFIG_ERROR", `MCP stdio server '${server.name}' requires a command.`);
    }

    return new Promise((resolve, reject) => {
      const command = server.command;
      if (!command) {
        reject(new AppError("CONFIG_ERROR", `MCP stdio server '${server.name}' requires a command.`));
        return;
      }
      const child: ChildProcessWithoutNullStreams = spawn(command, server.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new AppError("TIMEOUT_ERROR", `MCP server '${server.name}' timed out.`));
      }, server.timeoutMs);

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => {
        clearTimeout(timeout);
        reject(new AppError("TOOL_ERROR", `Failed to start MCP server '${server.name}'.`, { cause: error }));
      });
      child.on("close", () => {
        clearTimeout(timeout);
        if (stderr.trim().length > 0) {
          reject(new AppError("TOOL_ERROR", `MCP server '${server.name}' stderr: ${stderr.trim()}`));
          return;
        }
        const line = stdout
          .split("\n")
          .map((entry) => entry.trim())
          .find((entry) => entry.length > 0);
        if (!line) {
          reject(new AppError("TOOL_ERROR", `MCP server '${server.name}' returned no response.`));
          return;
        }
        try {
          const parsed = JSON.parse(line) as MCPResponse;
          if (parsed.error) {
            reject(new AppError("TOOL_ERROR", `MCP server '${server.name}' error: ${parsed.error}`));
            return;
          }
          resolve(parsed.result);
        } catch (error) {
          reject(new AppError("TOOL_ERROR", `Invalid JSON from MCP server '${server.name}'.`, { cause: error }));
        }
      });
      child.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
      child.stdin.end();
    });
  }

  private async sendViaHttp(server: MCPServerConfig, request: MCPRequest): Promise<unknown> {
    if (!server.url) {
      throw new AppError("CONFIG_ERROR", `MCP HTTP server '${server.name}' requires a URL.`);
    }
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(server.timeoutMs),
    });
    if (!response.ok) {
      throw new AppError("TOOL_ERROR", `MCP HTTP server '${server.name}' returned ${response.status}.`);
    }
    const parsed = (await response.json()) as MCPResponse;
    if (parsed.error) {
      throw new AppError("TOOL_ERROR", `MCP HTTP server '${server.name}' error: ${parsed.error}`);
    }
    return parsed.result;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  throw new AppError("TOOL_ERROR", "MCP server returned a non-object discovery payload.");
}
