import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";

import { Command } from "commander";

import { loadSettings } from "./config.js";
import { handleApprovalsFlow } from "./commands/approvals-command.js";
import { applyWorkspaceEnvToProcess } from "./env.js";
import { AppError } from "./errors.js";
import type { LLMStreamEvent } from "./llm/client.js";
import { createLLMClient } from "./llm/providers.js";
import { AnalyzerAgent } from "./agents/analyzer.js";
import { runChatCommand, type ChatCommandOptions as InteractiveChatCommandOptions } from "./chat/interactive.js";
import { ApprovalManager } from "./harness/approvals.js";
import { SessionSupervisor } from "./harness/session-supervisor.js";
import { ArtifactStore } from "./memory/artifact-store.js";
import { RunStore } from "./memory/run-store.js";
import { PermissionPolicy } from "./policy/permissions.js";
import { createLogger } from "./logger.js";
import { MCPClient } from "./mcp/client.js";
import { Orchestrator } from "./orchestrator.js";
import { renderApprovals } from "./rendering/approvals.js";
import { createLLMStreamRenderer, renderHarnessEvent } from "./rendering/runtime-output.js";
import { renderRunResult } from "./rendering/run-result.js";
import { ToolRegistry } from "./tools/registry.js";
import { RunBudgetStateSchema, RunRequestSchema, type OutputFormat, type Settings, type TelemetryEvent } from "./schemas.js";

const program = new Command();

interface BaseOptions {
  [key: string]: unknown;
  cwd: string;
  output?: OutputFormat;
  artifactDir?: string;
}

interface RunCommandOptions extends BaseOptions {
  profile: string;
  dryRun: boolean;
  maxIterations?: number;
  approvalMode?: Settings["approvalMode"];
  artifactDir?: string;
  stream: boolean;
}

type PlanCommandOptions = BaseOptions;
type RunIdCommandOptions = BaseOptions;
type DoctorCommandOptions = BaseOptions;
interface ApprovalsCommandOptions extends RunIdCommandOptions {
  approve?: string;
  deny?: string;
  resume?: boolean;
  stream?: boolean;
}
interface SessionCommandOptions extends RunIdCommandOptions {
  inspect?: string;
  cancel?: string;
  reconcile?: boolean;
}

interface CliChatCommandOptions extends InteractiveChatCommandOptions {
  resume?: string;
  new?: boolean;
}

program
  .name("little-helper")
  .description("Multi-agent CLI runtime with analyzer, executor, evaluator, and durable harness state.")
  .version("0.1.0");

program
  .command("chat")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--profile <name>", "config profile", "default")
  .option("--dry-run", "analyze without side effects", false)
  .option("--max-iterations <number>", "maximum analyzer/executor/evaluator loops", parseInteger)
  .option("--approval-mode <mode>", "never, on-risk, always")
  .option("--output <format>", "text or json", "text")
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--resume <sessionId>", "resume an existing chat session")
  .option("--new", "start a fresh session")
  .option("--mode <mode>", "suggest, auto-edit, or full-auto", "suggest")
  .option("--model <id>", "override the session model")
  .option("--no-stream", "disable streaming progress")
  .action(async (options: CliChatCommandOptions) => {
    await runChatCommand({
      cwd: path.resolve(options.cwd),
      profile: options.profile,
      dryRun: Boolean(options.dryRun),
      ...(typeof options.maxIterations === "number" ? { maxIterations: options.maxIterations } : {}),
      ...(typeof options.artifactDir === "string" ? { artifactDir: options.artifactDir } : {}),
      ...(typeof options.approvalMode === "string" ? { approvalMode: options.approvalMode } : {}),
      output: (asString(options.output) as OutputFormat | undefined) ?? "text",
      ...(typeof options.resume === "string" ? { resume: options.resume } : {}),
      new: Boolean(options.new),
      stream: typeof options.stream === "boolean" ? options.stream : true,
      ...(typeof options.mode === "string"
        ? { mode: options.mode as NonNullable<InteractiveChatCommandOptions["mode"]> }
        : {}),
      ...(typeof options.model === "string" ? { model: options.model } : {}),
    });
  });

program
  .command("run")
  .argument("<task>", "task to execute")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--profile <name>", "config profile", "default")
  .option("--dry-run", "analyze without side effects", false)
  .option("--max-iterations <number>", "maximum analyzer/executor/evaluator loops", parseInteger)
  .option("--approval-mode <mode>", "never, on-risk, always")
  .option("--output <format>", "text or json", "text")
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--no-stream", "disable streaming progress")
  .action(async (task: string, options: RunCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const logger = createLogger(settings);
    const llmStreamRenderer = createCLIStreamRenderer(settings.outputFormat, { textMode: "assistant" });
    const orchestrator = new Orchestrator(
      settings,
      logger,
      settings.stream
        ? {
            onEvent: llmStreamRenderer.onEvent,
            onLLMEvent: llmStreamRenderer.onLLMEvent,
          }
        : {},
    );
    const request = RunRequestSchema.parse({
      task,
      workingDirectory: path.resolve(options.cwd),
      profile: options.profile,
      dryRun: Boolean(options.dryRun),
      maxIterations: options.maxIterations ?? settings.maxIterations,
      metadata: {},
    });
    const result = await orchestrator.run(request);
    llmStreamRenderer.finish();
    renderRunResult(
      {
        writeLine: (line: string) => console.log(line),
      },
      result,
      settings.outputFormat,
      {
        omitAssistantReply: llmStreamRenderer.hasStreamedAssistantContent(),
      },
    );
    process.exitCode = result.state.status === "completed" ? 0 : 1;
  });

program
  .command("plan")
  .argument("<task>", "task to analyze")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--output <format>", "text or json", "text")
  .action(async (task: string, options: PlanCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, { ...options, stream: false });
    const llmStreamRenderer = createCLIStreamRenderer(settings.outputFormat);
    const request = RunRequestSchema.parse({
      task,
      workingDirectory: path.resolve(options.cwd),
      profile: "default",
      dryRun: true,
      maxIterations: 1,
      metadata: {},
    });
    const analysis = await new AnalyzerAgent().run(request, {
      runId: "plan-preview",
      workingDirectory: request.workingDirectory,
      settings,
      permissions: ["read-only"],
      dryRun: true,
      llm: createLLMClient(settings),
      tools: await ToolRegistry.create(settings),
      policy: new PermissionPolicy(settings),
      approvalManager: new ApprovalManager(new ArtifactStore(settings.artifactDir, "plan-preview")),
      approvals: [],
      artifactStore: new ArtifactStore(settings.artifactDir, "plan-preview"),
      logger: createLogger(settings),
      budget: RunBudgetStateSchema.parse({ maxIterations: 1 }),
      stepTrace: [],
      ...(settings.stream ? { onLLMEvent: llmStreamRenderer.onLLMEvent } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    llmStreamRenderer.finish();
    render(analysis, settings.outputFormat);
    process.exitCode = 0;
  });

program
  .command("eval")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const artifactStore = new RunStore(settings.artifactDir).createArtifactStore(runId);
    const evaluation = await artifactStore.readJson("evaluation.json");
    render(evaluation, settings.outputFormat);
  });

program
  .command("status")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const state = await new RunStore(settings.artifactDir).createArtifactStore(runId).readJson("harness-state.json");
    render(state, settings.outputFormat);
  });

program
  .command("logs")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const text = await new RunStore(settings.artifactDir).createArtifactStore(runId).readText("events.jsonl");
    console.log(text);
  });

program
  .command("artifacts")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const files = await new RunStore(settings.artifactDir).createArtifactStore(runId).listRunFiles();
    render(files, settings.outputFormat);
  });

program
  .command("diff")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    render(await buildDiffReport(settings.artifactDir, runId), settings.outputFormat);
  });

program
  .command("review")
  .argument("<target...>", "run identifier or task")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--profile <name>", "config profile", "default")
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .option("--no-stream", "disable streaming progress")
  .action(async (target: string[], options: RunCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const joined = target.join(" ").trim();
    const runStore = new RunStore(settings.artifactDir);
    const runs = await runStore.listRuns();
    if (runs.includes(joined)) {
      const artifactStore = runStore.createArtifactStore(joined);
      render(await buildReviewReport(artifactStore), settings.outputFormat);
      return;
    }
    const logger = createLogger(settings);
    const llmStreamRenderer = createCLIStreamRenderer(settings.outputFormat);
    const orchestrator = new Orchestrator(
      settings,
      logger,
      settings.stream
        ? {
            onEvent: llmStreamRenderer.onEvent,
            onLLMEvent: llmStreamRenderer.onLLMEvent,
          }
        : {},
    );
    const request = RunRequestSchema.parse({
      task: joined,
      workingDirectory: path.resolve(options.cwd),
      profile: options.profile,
      dryRun: false,
      maxIterations: settings.maxIterations,
      metadata: {},
    });
    const result = await orchestrator.run(request);
    llmStreamRenderer.finish();
    render(
      {
        runId: result.state.runId,
        status: result.state.status,
        evaluation: result.evaluation,
        finalReportArtifact: result.state.finalReportArtifact,
      },
      settings.outputFormat,
    );
  });

program
  .command("resume")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const logger = createLogger(settings);
    const llmStreamRenderer = createCLIStreamRenderer(settings.outputFormat, { textMode: "assistant" });
    const orchestrator = new Orchestrator(
      settings,
      logger,
      settings.stream
        ? {
            onEvent: llmStreamRenderer.onEvent,
            onLLMEvent: llmStreamRenderer.onLLMEvent,
          }
        : {},
    );
    const result = await orchestrator.resume(runId);
    llmStreamRenderer.finish();
    renderRunResult(
      {
        writeLine: (line: string) => console.log(line),
      },
      result,
      settings.outputFormat,
      {
        omitAssistantReply: llmStreamRenderer.hasStreamedAssistantContent(),
      },
    );
  });

program
  .command("cancel")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const artifactStore = new RunStore(settings.artifactDir).createArtifactStore(runId);
    const state = await artifactStore.readJson<Record<string, unknown>>("harness-state.json");
    const nextState = {
      ...state,
      status: "cancelled",
      phase: "cancelled",
      updatedAt: new Date().toISOString(),
    };
    await artifactStore.writeJson("harness-state.json", nextState);
    console.log(`Cancelled run ${runId}`);
  });

program
  .command("doctor")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (options: DoctorCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const report = await runDoctor(settings, path.resolve(options.cwd));
    render(report, settings.outputFormat);
    process.exitCode = report.ok ? 0 : 2;
  });

const configCommand = new Command("config");
program.addCommand(configCommand);

configCommand
  .command("validate")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .action(async (options: BaseOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    render({ ok: true, settings }, settings.outputFormat);
  });

const toolsCommand = new Command("tools");
program.addCommand(toolsCommand);

toolsCommand
  .command("list")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (options: BaseOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const tools = (await ToolRegistry.create(settings)).list().map((tool) => tool.descriptor);
    render(tools, settings.outputFormat);
  });

const mcpCommand = new Command("mcp");
program.addCommand(mcpCommand);

mcpCommand
  .command("list")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (options: BaseOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const registry = await ToolRegistry.create(settings);
    render(registry.listMCPServers(), settings.outputFormat);
  });

mcpCommand
  .command("inspect")
  .argument("<serverName>", "mcp server name")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (serverName: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const registry = await ToolRegistry.create(settings);
    render(registry.getMCPServer(serverName), settings.outputFormat);
  });

program
  .command("approvals")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .option("--approve <approvalId>", "approve an approval request")
  .option("--deny <approvalId>", "deny an approval request")
  .option("--resume", "resume the run immediately after approval")
  .option("--no-stream", "disable streaming progress while resuming")
  .action(async (runId: string, options: ApprovalsCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const artifactStore = new RunStore(settings.artifactDir).createArtifactStore(runId);
    const manager = new ApprovalManager(artifactStore);
    const approveId = asString(options.approve);
    const denyId = asString(options.deny);
    await handleApprovalsFlow(
      {
        runId,
        settings,
        ...(approveId ? { approveId } : {}),
        ...(denyId ? { denyId } : {}),
        resume: Boolean(options.resume),
      },
      {
        manager,
        writer: {
          writeLine: (line: string) => console.log(line),
        },
        logger: createLogger(settings),
        createOrchestrator: (resolvedSettings, logger, onEvent, onLLMEvent) =>
          new Orchestrator(resolvedSettings, logger, {
            ...(onEvent ? { onEvent } : {}),
            ...(onLLMEvent ? { onLLMEvent } : {}),
          }),
        createStreamRenderer: createCLIStreamRenderer,
      },
    );
  });

program
  .command("sessions")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .option("--inspect <sessionId>", "inspect and refresh a specific session")
  .option("--cancel <sessionId>", "cancel a specific running session")
  .option("--reconcile", "reconcile persisted running sessions against the local process table")
  .action(async (runId: string, options: SessionCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const artifactStore = new RunStore(settings.artifactDir).createArtifactStore(runId);
    const supervisor = new SessionSupervisor(artifactStore);
    const inspectId = asString(options.inspect);
    const cancelId = asString(options.cancel);
    if (inspectId && cancelId) {
      throw new AppError("VALIDATION_ERROR", "Choose either --inspect or --cancel, not both.");
    }
    if (inspectId) {
      const session = await supervisor.inspect(inspectId);
      if (!session) {
        throw new AppError("NOT_FOUND", `Session not found: ${inspectId}`);
      }
      render(session, settings.outputFormat);
      return;
    }
    if (cancelId) {
      const session = await supervisor.cancel(cancelId);
      if (!session) {
        throw new AppError("NOT_FOUND", `Session not found: ${cancelId}`);
      }
      render(session, settings.outputFormat);
      return;
    }
    if (options.reconcile) {
      render(await supervisor.reconcileRunningSessions("manual"), settings.outputFormat);
      return;
    }
    render(await safeReadJson(artifactStore, "sessions.json", []), settings.outputFormat);
  });

program
  .command("checkpoints")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const runDir = new RunStore(settings.artifactDir).createArtifactStore(runId).checkpointsDirectory;
    const files = await readdir(runDir);
    render(files, settings.outputFormat);
  });

program
  .command("recover")
  .argument("<runId>", "run identifier")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--artifact-dir <path>", "artifact directory override")
  .option("--output <format>", "text or json", "text")
  .action(async (runId: string, options: RunIdCommandOptions) => {
    const settings = await loadCliSettings(options.cwd, options);
    const artifactStore = new RunStore(settings.artifactDir).createArtifactStore(runId);
    const state = await artifactStore.readJson<Record<string, unknown>>("harness-state.json");
    const report = {
      state,
      checkpoints: await readdir(artifactStore.checkpointsDirectory),
    };
    render(report, settings.outputFormat);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    handleError(error);
  }
}

void main();

async function loadCliSettings(cwd: string, options: Record<string, unknown>): Promise<Settings> {
  const resolvedCwd = path.resolve(cwd);
  await applyWorkspaceEnvToProcess(resolvedCwd);
  const artifactDir = asString(options.artifactDir);
  const approvalMode = asString(options.approvalMode) as Settings["approvalMode"] | undefined;
  const overrides = {
    ...(artifactDir ? { artifactDir } : {}),
    ...(approvalMode ? { approvalMode } : {}),
    ...(typeof options.maxIterations === "number" ? { maxIterations: options.maxIterations } : {}),
    outputFormat: (asString(options.output) as OutputFormat | undefined) ?? "text",
    stream: typeof options.stream === "boolean" ? options.stream : true,
  };
  return loadSettings(resolvedCwd, overrides);
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

function render(value: unknown, outputFormat: OutputFormat): void {
  if (outputFormat === "json") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function createCLIStreamRenderer(
  outputFormat: OutputFormat,
  options?: {
    textMode?: "internal" | "assistant";
  },
): {
  onEvent: (event: TelemetryEvent) => void;
  onLLMEvent: (event: LLMStreamEvent) => void;
  hasStreamedAssistantContent: () => boolean;
  finish: () => void;
} {
  const writer = {
    write: (text: string) => process.stdout.write(text),
    writeLine: (line: string) => console.log(line),
  };
  const renderer = createLLMStreamRenderer(
    writer,
    outputFormat,
    options,
  );
  return {
    onEvent: (event) => renderHarnessEvent(writer, outputFormat, event),
    onLLMEvent: renderer.onLLMEvent,
    hasStreamedAssistantContent: renderer.hasStreamedAssistantContent,
    finish: renderer.finish,
  };
}

function handleError(error: unknown): never {
  if (error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(4);
}

async function runDoctor(settings: Settings, cwd: string): Promise<Record<string, unknown>> {
  const llm = createLLMClient(settings);
  const llmStatus = await llm.healthCheck();
  const policy = new PermissionPolicy(settings);
  const registry = await ToolRegistry.create(settings);
  const toolCount = registry.list().length;
  const mcp = settings.mcpServers.length > 0 ? await new MCPClient(settings).discoverAll() : [];
  const artifactDirWritable = await ensureWritable(settings.artifactDir);
  const configValid = Boolean(settings.artifactDir);
  const nodeVersionOk = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 22;
  const packageJsonReadable = await canRead(path.join(cwd, "package.json"));
  try {
    policy.ensurePathAllowed(cwd);
  } catch (error) {
    throw new AppError("CONFIG_ERROR", "Working directory is outside allowed roots.", { cause: error });
  }
  return {
    ok: nodeVersionOk && artifactDirWritable && configValid && llmStatus.ok,
    checks: {
      nodeVersion: process.versions.node,
      nodeVersionOk,
      packageJsonReadable,
      configValid,
      artifactDirWritable,
      toolCount,
      mcp,
      llm: llmStatus,
    },
  };
}

async function ensureWritable(targetDirectory: string): Promise<boolean> {
  try {
    await access(targetDirectory, fsConstants.W_OK);
    return true;
  } catch {
    try {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(path.join(targetDirectory, ".healthcheck"), "ok", "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

async function canRead(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeReadJson<T>(artifactStore: ArtifactStore, fileName: string, fallback: T): Promise<T> {
  try {
    return await artifactStore.readJson<T>(fileName);
  } catch {
    return fallback;
  }
}

async function buildDiffReport(artifactDir: string, runId: string): Promise<Record<string, unknown>> {
  const artifactStore = new RunStore(artifactDir).createArtifactStore(runId);
  const files = await readdir(artifactStore.artifactsDirectory);
  return {
    runId,
    changedFiles: await safeReadJson<string[]>(artifactStore, "changed-files.json", []),
    patches: files.filter((file) => file.endsWith(".patch")).sort(),
  };
}

async function buildReviewReport(artifactStore: ArtifactStore): Promise<Record<string, unknown>> {
  let finalReport: string | undefined;
  try {
    finalReport = await readFile(artifactStore.resolve("final-report.md"), "utf8");
  } catch {
    finalReport = undefined;
  }

  return {
    state: await safeReadJson<Record<string, unknown>>(artifactStore, "harness-state.json", {}),
    evaluation: await safeReadJson<Record<string, unknown>>(artifactStore, "evaluation.json", {}),
    finalReport,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
