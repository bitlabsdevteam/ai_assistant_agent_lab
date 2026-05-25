import type { z } from "zod";

import { AppError } from "../errors.js";
import { MCPClient } from "../mcp/client.js";
import { buildApprovalRequest, type PolicyDecision } from "../policy/permissions.js";
import { createEvent } from "../telemetry/events.js";
import {
  MCPToolResultSchema,
  type ApprovalRequest,
  type MCPDiscovery,
  type MCPServerConfig,
  type ToolCallRecord,
} from "../schemas.js";
import type { ArtifactStore } from "../memory/artifact-store.js";
import type { PermissionPolicy } from "../policy/permissions.js";
import { DiffTool, FileSystemListTool, FileSystemReadTool, FileSystemWriteTool, GitReadTool, PatchTool, SearchTool } from "./filesystem.js";
import { buildDescriptor, type RegisteredTool, type Tool, type ToolContext } from "./base.js";
import { ShellTool, ValidationTool } from "./shell.js";
import { WebFetchTool, WebSearchTool } from "./web.js";

function toRegisteredTool<
  TInput extends z.ZodType<unknown, z.ZodTypeDef, unknown>,
  TOutput extends z.ZodType<unknown, z.ZodTypeDef, unknown>,
>(
  tool: Tool<TInput, TOutput>,
): RegisteredTool {
  return {
    descriptor: tool.descriptor,
    invoke: async (input: unknown, context: ToolContext) => {
      const parsedInput = tool.inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw parsedInput.error;
      }
      await tool.validate(parsedInput.data, context);
      const result = await tool.run(parsedInput.data, context);
      const parsedOutput = tool.outputSchema.safeParse(result);
      if (!parsedOutput.success) {
        throw parsedOutput.error;
      }
      return parsedOutput.data;
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly shellTool = new ShellTool();
  private readonly mcpDiscoveries = new Map<string, MCPDiscovery>();

  public constructor() {
    this.register(toRegisteredTool(new FileSystemReadTool()));
    this.register(toRegisteredTool(new FileSystemListTool()));
    this.register(toRegisteredTool(new FileSystemWriteTool()));
    this.register(toRegisteredTool(new PatchTool()));
    this.register(toRegisteredTool(new SearchTool()));
    this.register(toRegisteredTool(new DiffTool()));
    this.register(toRegisteredTool(new GitReadTool()));
    this.register(toRegisteredTool(this.shellTool));
    this.register(toRegisteredTool(new ValidationTool()));
    this.register(toRegisteredTool(new WebFetchTool()));
    this.register(toRegisteredTool(new WebSearchTool()));
  }

  public static async create(settings: ToolContext["settings"]): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    if (settings.mcpServers.length > 0) {
      await registry.registerMCPServers(settings.mcpServers, new MCPClient(settings));
    }
    return registry;
  }

  public register(tool: RegisteredTool): void {
    this.tools.set(tool.descriptor.name, tool);
  }

  public list(): RegisteredTool[] {
    return [...this.tools.values()].sort((left, right) => left.descriptor.name.localeCompare(right.descriptor.name));
  }

  public get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AppError("NOT_FOUND", `Tool not found: ${name}`);
    }
    return tool;
  }

  public listMCPServers(): MCPDiscovery[] {
    return [...this.mcpDiscoveries.values()].sort((left, right) => left.server.localeCompare(right.server));
  }

  public getMCPServer(name: string): MCPDiscovery {
    const discovery = this.mcpDiscoveries.get(name);
    if (!discovery) {
      throw new AppError("NOT_FOUND", `MCP server not found: ${name}`);
    }
    return discovery;
  }

  public async invoke(
    name: string,
    input: unknown,
    context: ToolContext,
    artifactStore: ArtifactStore,
    policy: PermissionPolicy,
    options?: {
      stepId?: string;
    },
  ): Promise<{
    result?: unknown;
    record: ToolCallRecord;
    approvalRequest?: ApprovalRequest;
  }> {
    const tool = this.get(name);
    const startedAt = new Date().toISOString();
    let completionStatus: "success" | "failed" | "denied" | undefined;
    await emitToolEvent(context, "tool.started", "running", tool.descriptor.name, {
      ...(tool.descriptor.category ? { category: tool.descriptor.category } : {}),
      ...(options?.stepId ? { stepId: options.stepId } : {}),
    });
    const decision = policy.decideTool(tool.descriptor, input, undefined, context.operatorMode, context.approvals);
    if (decision.outcome !== "allow") {
      if (decision.outcome === "require_approval") {
        await emitToolEvent(context, "tool.awaiting_approval", "pending", tool.descriptor.name, {
          ...(tool.descriptor.category ? { category: tool.descriptor.category } : {}),
          ...(options?.stepId ? { stepId: options.stepId } : {}),
          reason: decision.reason,
        });
      } else {
        completionStatus = "denied";
        await emitToolEvent(context, "tool.completed", "denied", tool.descriptor.name, {
          ...(tool.descriptor.category ? { category: tool.descriptor.category } : {}),
          ...(options?.stepId ? { stepId: options.stepId } : {}),
          reason: decision.reason,
        });
      }
      return handlePolicyOutcome(
        context.runId,
        tool.descriptor,
        input,
        startedAt,
        decision,
        context.workingDirectory,
        options?.stepId,
      );
    }

    try {
      const result = await tool.invoke(input, context);
      const artifactName = `tool-${sanitizeFileName(tool.descriptor.name)}-${Date.now()}.json`;
      const outputArtifact = await artifactStore.writeArtifactJson(artifactName, result);
      const enriched = enrichRecordFromResult(result);
      completionStatus = "success";
      return {
        result,
        record: {
          id: `${context.runId}-${tool.descriptor.name}-${Date.now()}`,
          toolName: tool.descriptor.name,
          category: tool.descriptor.category,
          ...(options?.stepId ? { stepId: options.stepId } : {}),
          inputSummary: summarizeInput(input),
          status: "success",
          startedAt,
          completedAt: new Date().toISOString(),
          cwd: context.workingDirectory,
          approvalProvenance: "policy_allowed",
          ...enriched,
          outputArtifact,
        },
      };
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError("TOOL_ERROR", `Tool execution failed: ${tool.descriptor.name}`, { cause: error });
      completionStatus = appError.code === "POLICY_ERROR" ? "denied" : "failed";
      return {
        record: {
          id: `${context.runId}-${tool.descriptor.name}-${Date.now()}`,
          toolName: tool.descriptor.name,
          category: tool.descriptor.category,
          ...(options?.stepId ? { stepId: options.stepId } : {}),
          inputSummary: summarizeInput(input),
          status: appError.code === "POLICY_ERROR" ? "denied" : "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          cwd: context.workingDirectory,
          approvalProvenance: "policy_allowed",
          error: appError.message,
        },
      };
    } finally {
      // Best-effort completion signal for live UI. Policy-pending calls emit a dedicated awaiting-approval event above.
      if (decision.outcome === "allow") {
        await emitToolEvent(context, "tool.completed", completionStatus ?? "success", tool.descriptor.name, {
          ...(tool.descriptor.category ? { category: tool.descriptor.category } : {}),
          ...(options?.stepId ? { stepId: options.stepId } : {}),
        });
      }
    }
  }

  private async registerMCPServers(servers: MCPServerConfig[], client: MCPClient): Promise<void> {
    const discoveries = await Promise.all(servers.filter((server) => server.enabled).map(async (server) => ({
      server,
      discovery: await client.discoverServer(server),
    })));

    for (const item of discoveries) {
      this.mcpDiscoveries.set(item.discovery.server, item.discovery);
      if (item.discovery.status !== "ready") {
        continue;
      }
      for (const tool of item.discovery.tools) {
        if (item.server.allowedTools.length > 0 && !item.server.allowedTools.includes(tool.name)) {
          continue;
        }
        const toolName = `mcp.${item.server.name}.${tool.name}`;
        this.register({
          descriptor: buildDescriptor({
            name: toolName,
            description: `${tool.description} (MCP server: ${item.server.name})`,
            category: "mcp",
            riskLevel: tool.riskLevel,
            sideEffecting: tool.sideEffecting,
            requiresApproval: tool.requiresApproval,
            permissionScope: tool.permissionScope,
            dryRunSafe: !tool.sideEffecting,
          }),
          invoke: async (input: unknown) => {
            const result = await client.invokeTool(item.server, tool.name, input);
            return MCPToolResultSchema.parse(result);
          },
        });
      }
    }
  }
}

async function emitToolEvent(
  context: ToolContext,
  event: string,
  status: string,
  toolName: string,
  details?: Record<string, unknown>,
): Promise<void> {
  if (!context.onTelemetryEvent) {
    return;
  }
  await context.onTelemetryEvent(
    createEvent({
      runId: context.runId,
      event,
      status,
      toolName,
      ...(details ? { details } : {}),
    }),
  );
}

function handlePolicyOutcome(
  runId: string,
  tool: { name: string; category: ToolCallRecord["category"]; riskLevel: "low" | "medium" | "high" },
  input: unknown,
  startedAt: string,
  decision: PolicyDecision,
  workingDirectory: string,
  stepId?: string,
): {
  record: ToolCallRecord;
  approvalRequest?: ApprovalRequest;
} {
  if (decision.outcome === "require_approval") {
    const approvalRequest = buildApprovalRequest(
      runId,
      {
        name: tool.name,
        description: tool.name,
        category: tool.category ?? "execution",
        riskLevel: decision.riskLevel,
        sideEffecting: true,
        permissionScope: "privileged",
        requiresApproval: true,
        dryRunSafe: false,
      },
      summarizeInput(input),
      input,
      decision.reason,
      decision.riskLevel,
      stepId ? { stepId } : undefined,
    );
    return {
      approvalRequest,
      record: {
        id: `${runId}-${tool.name}-${Date.now()}`,
        toolName: tool.name,
        category: tool.category,
        ...(stepId ? { stepId } : {}),
        inputSummary: summarizeInput(input),
        status: "skipped",
        startedAt,
        completedAt: new Date().toISOString(),
        cwd: workingDirectory,
        approvalProvenance: "pending",
        error: decision.reason,
      },
    };
  }

  return {
    record: {
      id: `${runId}-${tool.name}-${Date.now()}`,
      toolName: tool.name,
      category: tool.category,
      ...(stepId ? { stepId } : {}),
      inputSummary: summarizeInput(input),
      status: "denied",
      startedAt,
      completedAt: new Date().toISOString(),
      cwd: workingDirectory,
      approvalProvenance: "denied",
      error: decision.reason,
    },
  };
}

function enrichRecordFromResult(result: unknown): Partial<ToolCallRecord> {
  if (!result || typeof result !== "object") {
    return {};
  }

  const candidate = result as {
    normalizedCommand?: string;
    exitCode?: number;
    stdoutSummary?: string;
    stderrSummary?: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  };

  return {
    ...(typeof candidate.normalizedCommand === "string" ? { command: candidate.normalizedCommand } : {}),
    ...(typeof candidate.exitCode === "number" ? { exitCode: candidate.exitCode } : {}),
    ...(typeof candidate.stdoutSummary === "string"
      ? { stdoutSummary: candidate.stdoutSummary }
      : summarizeResult(result)
        ? { stdoutSummary: summarizeResult(result) }
        : {}),
    ...(typeof candidate.stderrSummary === "string" ? { stderrSummary: candidate.stderrSummary } : {}),
    ...(typeof candidate.stdoutTruncated === "boolean" || typeof candidate.stderrTruncated === "boolean"
      ? { outputTruncated: Boolean(candidate.stdoutTruncated || candidate.stderrTruncated) }
      : {}),
  };
}

function summarizeResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const webSearchResult = result as {
    provider?: unknown;
    query?: unknown;
    resultCount?: unknown;
    results?: Array<{ title?: unknown; snippet?: unknown }>;
  };
  if (
    webSearchResult.provider === "perplexity" &&
    typeof webSearchResult.query === "string" &&
    typeof webSearchResult.resultCount === "number"
  ) {
    const top = webSearchResult.results?.[0];
    const topSummary =
      typeof top?.title === "string" && typeof top?.snippet === "string"
        ? ` Top result: ${top.title} - ${top.snippet}`
        : "";
    return `Found ${webSearchResult.resultCount} web result(s) for "${webSearchResult.query}".${topSummary}`.trim();
  }

  return undefined;
}

function summarizeInput(input: unknown): string {
  const serialized = JSON.stringify(input);
  return serialized.length <= 200 ? serialized : `${serialized.slice(0, 200)}...`;
}

function sanitizeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9-_]+/g, "-");
}
