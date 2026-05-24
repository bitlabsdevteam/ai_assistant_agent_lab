import { createInterface } from "node:readline/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { Logger } from "pino";

import { AppError } from "../errors.js";
import { createLogger } from "../logger.js";
import { Orchestrator } from "../orchestrator.js";
import {
  ChatEventSchema,
  type ApprovalMode,
  type ChatEvent,
  type HarnessStatus,
  type InteractiveSessionState,
  type OperatorMode,
  type OutputFormat,
  type Settings,
  type TelemetryEvent,
} from "../schemas.js";
import { ChatSessionManager, type PendingSessionApproval } from "./session-manager.js";

export interface ChatCommandOptions {
  cwd: string;
  profile: string;
  dryRun: boolean;
  maxIterations?: number;
  artifactDir?: string;
  approvalMode?: ApprovalMode;
  output: OutputFormat;
  resume?: string;
  new?: boolean;
  stream: boolean;
  mode?: OperatorMode;
  model?: string;
}

export interface ChatConsole {
  isTTY(): boolean;
  prompt(label: string): Promise<string>;
  writeLine(line: string): void;
  close(): Promise<void>;
}

export interface ChatRuntimeDependencies {
  loadSettings: (cwd: string, options: Record<string, unknown>) => Promise<Settings>;
  createOrchestrator: (settings: Settings, logger: Logger, onEvent?: (event: TelemetryEvent) => void) => Orchestrator;
  createSessionManager: (artifactDir: string) => ChatSessionManager;
  console: ChatConsole;
}

export async function runChatCommand(
  options: ChatCommandOptions,
  dependencies: Partial<ChatRuntimeDependencies> = {},
): Promise<void> {
  const consoleAdapter = dependencies.console ?? new ReadlineChatConsole();
  if (!consoleAdapter.isTTY()) {
    throw new AppError(
      "VALIDATION_ERROR",
      'The "chat" command requires an interactive TTY. Use `little-helper run "TASK"` for non-interactive automation.',
    );
  }
  if (options.resume && options.new) {
    throw new AppError("VALIDATION_ERROR", "Choose either --resume or --new, not both.");
  }

  const loadSettings = dependencies.loadSettings ?? defaultLoadSettings;
  const baseSettings = await loadSettings(options.cwd, {
    cwd: options.cwd,
    artifactDir: options.artifactDir,
    approvalMode: options.approvalMode,
    maxIterations: options.maxIterations,
    outputFormat: options.output,
    stream: options.stream,
  });
  const logger = createLogger(baseSettings);
  const createOrchestrator = dependencies.createOrchestrator ?? defaultCreateOrchestrator;
  const sessionManager = (dependencies.createSessionManager ?? ((artifactDir: string) => new ChatSessionManager(artifactDir)))(
    baseSettings.artifactDir,
  );

  let session = options.resume
    ? await sessionManager.refreshSession(options.resume)
    : await sessionManager.createSession({
        workingDirectory: options.cwd,
        mode: options.mode ?? "suggest",
        ...(options.model ? { selectedModel: options.model } : {}),
      });
  if (options.resume) {
    if (options.mode) {
      await sessionManager.setMode(session.sessionId, options.mode);
    }
    if (options.model !== undefined) {
      await sessionManager.setSelectedModel(session.sessionId, options.model);
    }
  }
  let interactive = await sessionManager.loadInteractiveState(session.sessionId);
  emitChatEvent(consoleAdapter, baseSettings.outputFormat, {
    type: "chat.session_started",
    timestamp: new Date().toISOString(),
    sessionId: session.sessionId,
    status: session.status,
    message: `Session ${session.sessionId} ready`,
  });
  if (baseSettings.outputFormat === "text") {
    consoleAdapter.writeLine(renderWelcome(session.sessionId, interactive));
  }

  try {
    while (true) {
      const label = baseSettings.outputFormat === "json" ? "" : formatPromptLabel(session.sessionId, interactive);
      const input = (await consoleAdapter.prompt(label)).trim();
      if (input.length === 0) {
        continue;
      }
      if (input.startsWith("/")) {
        const next = await handleCommand(input, {
          session,
          interactive,
          sessionManager,
          console: consoleAdapter,
          settings: baseSettings,
          logger,
          createOrchestrator,
        });
        if (next === "exit") {
          break;
        }
        session = next.session;
        interactive = next.interactive;
        continue;
      }

      const prepared = await sessionManager.prepareTurn({
        sessionId: session.sessionId,
        message: input,
        profile: options.profile,
        dryRun: options.dryRun,
        maxIterations: options.maxIterations ?? baseSettings.maxIterations,
      });
      session = prepared.session;
      interactive = await sessionManager.loadInteractiveState(session.sessionId);
      emitChatEvent(consoleAdapter, baseSettings.outputFormat, {
        type: "chat.turn_started",
        timestamp: new Date().toISOString(),
        sessionId: session.sessionId,
        turnId: prepared.turnId,
        message: input,
      });

      const sessionSettings = resolveInteractiveSettings(baseSettings, interactive);
      const orchestrator = createOrchestrator(
        sessionSettings,
        logger,
        sessionSettings.stream ? (event) => renderHarnessEvent(consoleAdapter, sessionSettings.outputFormat, event) : undefined,
      );
      const result = await orchestrator.run(prepared.request);
      const reply = buildAssistantReply(result.state.status, result.state.runId, {
        executionSummary: result.execution?.summary,
        evaluationStatus: result.evaluation?.status,
      });
      session = await sessionManager.completeTurn({
        sessionId: session.sessionId,
        turnId: prepared.turnId,
        runId: result.state.runId,
        assistantContent: reply,
        assistantSummary: reply,
        artifactRefs: collectRunArtifacts(result.state),
        runStatus: result.state.status,
      });
      interactive = await sessionManager.loadInteractiveState(session.sessionId);
      writeAssistantReply(consoleAdapter, sessionSettings.outputFormat, reply, result.state.runId);
      emitChatEvent(consoleAdapter, sessionSettings.outputFormat, {
        type: "chat.turn_completed",
        timestamp: new Date().toISOString(),
        sessionId: session.sessionId,
        turnId: prepared.turnId,
        runId: result.state.runId,
        status: result.state.status,
      });
      if (result.state.status === "awaiting_approval" && sessionSettings.outputFormat === "text") {
        const pending = await sessionManager.listPendingApprovals(session.sessionId);
        consoleAdapter.writeLine(renderPendingApprovals(pending));
      }
    }
  } finally {
    await consoleAdapter.close();
  }
}

class ReadlineChatConsole implements ChatConsole {
  private readonly rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  public isTTY(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  public prompt(label: string): Promise<string> {
    return this.rl.question(label);
  }

  public close(): Promise<void> {
    this.rl.close();
    return Promise.resolve();
  }

  public writeLine(line: string): void {
    this.rl.write(`${line}\n`);
  }
}

async function handleCommand(
  input: string,
  dependencies: {
    session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>;
    interactive: InteractiveSessionState;
    sessionManager: ChatSessionManager;
    console: ChatConsole;
    settings: Settings;
    logger: Logger;
    createOrchestrator: (settings: Settings, logger: Logger, onEvent?: (event: TelemetryEvent) => void) => Orchestrator;
  },
): Promise<{ session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>; interactive: InteractiveSessionState } | "exit"> {
  const [command, ...args] = input.split(/\s+/);
  emitChatEvent(dependencies.console, dependencies.settings.outputFormat, {
    type: "chat.command_invoked",
    timestamp: new Date().toISOString(),
    sessionId: dependencies.session.sessionId,
    command,
    message: input,
  });

  switch (command) {
    case "/help":
      dependencies.console.writeLine(renderHelp());
      return { session: dependencies.session, interactive: dependencies.interactive };
    case "/status": {
      const session = await dependencies.sessionManager.refreshSession(dependencies.session.sessionId);
      const interactive = await dependencies.sessionManager.loadInteractiveState(session.sessionId);
      dependencies.console.writeLine(renderStatus(session, interactive));
      return { session, interactive };
    }
    case "/sessions": {
      const sessions = await dependencies.sessionManager.listSessions();
      dependencies.console.writeLine(sessions.length > 0 ? sessions.join("\n") : "No chat sessions yet.");
      return { session: dependencies.session, interactive: dependencies.interactive };
    }
    case "/runs": {
      const runIds = await dependencies.sessionManager.listRunIds(dependencies.session.sessionId);
      dependencies.console.writeLine(runIds.length > 0 ? runIds.join("\n") : "No runs yet.");
      return { session: dependencies.session, interactive: dependencies.interactive };
    }
    case "/resume": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /resume <runId>");
      }
      await dependencies.sessionManager.recordSystemTurn(dependencies.session.sessionId, input, `Resume run ${runId}`);
      const sessionSettings = resolveInteractiveSettings(dependencies.settings, dependencies.interactive);
      const orchestrator = dependencies.createOrchestrator(
        sessionSettings,
        dependencies.logger,
        sessionSettings.stream
          ? (event) => renderHarnessEvent(dependencies.console, sessionSettings.outputFormat, event)
          : undefined,
      );
      const result = await orchestrator.resume(runId);
      const reply = buildAssistantReply(result.state.status, result.state.runId, {
        executionSummary: result.execution?.summary,
        evaluationStatus: result.evaluation?.status,
      });
      const session = await dependencies.sessionManager.completeTurn({
        sessionId: dependencies.session.sessionId,
        turnId: createSyntheticTurnId("resume", runId),
        runId: result.state.runId,
        assistantContent: reply,
        assistantSummary: reply,
        artifactRefs: collectRunArtifacts(result.state),
        runStatus: result.state.status,
      });
      const interactive = await dependencies.sessionManager.loadInteractiveState(session.sessionId);
      writeAssistantReply(dependencies.console, sessionSettings.outputFormat, reply, result.state.runId);
      return { session, interactive };
    }
    case "/approvals": {
      const approvals = await dependencies.sessionManager.listPendingApprovals(dependencies.session.sessionId);
      dependencies.console.writeLine(renderPendingApprovals(approvals));
      return { session: dependencies.session, interactive: dependencies.interactive };
    }
    case "/approve":
    case "/deny": {
      const approvalId = args[0];
      if (!approvalId) {
        throw new AppError("VALIDATION_ERROR", `Usage: ${command} <approvalId>`);
      }
      const decision = command === "/approve" ? "approved" : "denied";
      const updated = await dependencies.sessionManager.decideApproval(dependencies.session.sessionId, approvalId, decision);
      if (!updated) {
        throw new AppError("NOT_FOUND", `Approval request not found: ${approvalId}`);
      }
      const session = await dependencies.sessionManager.recordSystemTurn(
        dependencies.session.sessionId,
        input,
        `${decision} approval ${approvalId}`,
      );
      const interactive = await dependencies.sessionManager.loadInteractiveState(session.sessionId);
      dependencies.console.writeLine(`${decision} ${approvalId} for run ${updated.runId}`);
      return { session, interactive };
    }
    case "/diff": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /diff <runId>");
      }
      dependencies.console.writeLine(await renderDiffSummary(dependencies.settings.artifactDir, runId));
      return { session: dependencies.session, interactive: dependencies.interactive };
    }
    case "/review": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /review <runId>");
      }
      dependencies.console.writeLine(await renderReviewSummary(dependencies.settings.artifactDir, runId));
      return { session: dependencies.session, interactive: dependencies.interactive };
    }
    case "/artifacts": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /artifacts <runId>");
      }
      const artifactPath = path.join(dependencies.settings.artifactDir, runId);
      const files = await readdir(artifactPath);
      dependencies.console.writeLine(files.sort().join("\n"));
      return { session: dependencies.session, interactive: dependencies.interactive };
    }
    case "/model": {
      if (args.length === 0) {
        dependencies.console.writeLine(dependencies.interactive.selectedModel ?? dependencies.settings.llmModel);
        return { session: dependencies.session, interactive: dependencies.interactive };
      }
      const modelArg = args[0];
      if (!modelArg) {
        throw new AppError("VALIDATION_ERROR", "Usage: /model [modelId|default]");
      }
      const interactive = await dependencies.sessionManager.setSelectedModel(
        dependencies.session.sessionId,
        modelArg === "default" ? undefined : modelArg,
      );
      dependencies.console.writeLine(`model: ${interactive.selectedModel ?? dependencies.settings.llmModel}`);
      return { session: dependencies.session, interactive };
    }
    case "/mode": {
      if (args.length === 0) {
        dependencies.console.writeLine(`mode: ${dependencies.interactive.mode}`);
        return { session: dependencies.session, interactive: dependencies.interactive };
      }
      const modeArg = args[0];
      if (!modeArg) {
        throw new AppError("VALIDATION_ERROR", "Usage: /mode [suggest|auto-edit|full-auto]");
      }
      const mode = parseMode(modeArg);
      const interactive = await dependencies.sessionManager.setMode(dependencies.session.sessionId, mode);
      dependencies.console.writeLine(`mode: ${interactive.mode}`);
      return { session: dependencies.session, interactive };
    }
    case "/context": {
      const session = await dependencies.sessionManager.refreshSession(dependencies.session.sessionId);
      const turns = await dependencies.sessionManager.listTurns(session.sessionId);
      const recentTurns = turns
        .slice(-4)
        .map((turn) => `${turn.role}: ${turn.summary ?? turn.content}`)
        .join("\n");
      dependencies.console.writeLine(
        [`Summary: ${session.conversationSummary || "none"}`, recentTurns ? `Recent turns:\n${recentTurns}` : ""]
          .filter((entry) => entry.length > 0)
          .join("\n\n"),
      );
      const interactive = await dependencies.sessionManager.loadInteractiveState(session.sessionId);
      return { session, interactive };
    }
    case "/reset": {
      const next = await dependencies.sessionManager.createSession({
        workingDirectory: dependencies.session.workingDirectory,
        mode: dependencies.interactive.mode,
        ...(dependencies.interactive.selectedModel ? { selectedModel: dependencies.interactive.selectedModel } : {}),
      });
      const interactive = await dependencies.sessionManager.loadInteractiveState(next.sessionId);
      emitChatEvent(dependencies.console, dependencies.settings.outputFormat, {
        type: "chat.session_started",
        timestamp: new Date().toISOString(),
        sessionId: next.sessionId,
        status: next.status,
        message: `Session ${next.sessionId} ready`,
      });
      dependencies.console.writeLine(`Started new session ${next.sessionId}`);
      return { session: next, interactive };
    }
    case "/exit":
      return "exit";
    default:
      throw new AppError("VALIDATION_ERROR", `Unknown command: ${command}. Use /help for available commands.`);
  }
}

function emitChatEvent(consoleAdapter: ChatConsole, outputFormat: OutputFormat, event: Omit<ChatEvent, "timestamp"> & { timestamp: string }): void {
  const parsed = ChatEventSchema.parse(event);
  if (outputFormat === "json") {
    consoleAdapter.writeLine(JSON.stringify(parsed));
  }
}

function renderHarnessEvent(consoleAdapter: ChatConsole, outputFormat: OutputFormat, event: TelemetryEvent): void {
  if (outputFormat === "json") {
    consoleAdapter.writeLine(JSON.stringify({ type: "harness.event", ...event }));
    return;
  }
  const label = event.event.replaceAll(".", " ");
  consoleAdapter.writeLine(`[${event.runId}] ${label} (${event.status})`);
}

function writeAssistantReply(consoleAdapter: ChatConsole, outputFormat: OutputFormat, reply: string, runId: string): void {
  if (outputFormat === "json") {
    consoleAdapter.writeLine(JSON.stringify({ role: "assistant", runId, content: reply }));
    return;
  }
  consoleAdapter.writeLine(reply);
  consoleAdapter.writeLine(`run: ${runId}`);
}

function buildAssistantReply(
  status: HarnessStatus,
  runId: string,
  details: {
    executionSummary?: string | undefined;
    evaluationStatus?: string | undefined;
  },
): string {
  const fragments = [
    `Run ${runId} finished with status ${status}.`,
    details.executionSummary,
    details.evaluationStatus ? `Evaluation: ${details.evaluationStatus}.` : undefined,
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return fragments.join(" ");
}

function collectRunArtifacts(state: {
  requestArtifact?: string | undefined;
  analysisArtifact?: string | undefined;
  executionArtifact?: string | undefined;
  evaluationArtifact?: string | undefined;
  finalReportArtifact?: string | undefined;
}): string[] {
  return [
    state.requestArtifact,
    state.analysisArtifact,
    state.executionArtifact,
    state.evaluationArtifact,
    state.finalReportArtifact,
  ].filter((artifact): artifact is string => typeof artifact === "string" && artifact.length > 0);
}

function renderPendingApprovals(approvals: PendingSessionApproval[]): string {
  if (approvals.length === 0) {
    return "No pending approvals.";
  }
  return approvals
    .map((approval) => `${approval.id} ${approval.toolName} ${approval.status} run=${approval.runId} reason=${approval.reason}`)
    .join("\n");
}

function renderHelp(): string {
  return [
    "/help",
    "/status",
    "/sessions",
    "/runs",
    "/resume <runId>",
    "/approvals",
    "/approve <approvalId>",
    "/deny <approvalId>",
    "/mode [suggest|auto-edit|full-auto]",
    "/model [modelId|default]",
    "/diff <runId>",
    "/review <runId>",
    "/artifacts <runId>",
    "/context",
    "/reset",
    "/exit",
  ].join("\n");
}

function renderStatus(
  session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>,
  interactive: InteractiveSessionState,
): string {
  return [
    `session: ${session.sessionId}`,
    `status: ${session.status}`,
    `turns: ${session.turns}`,
    `mode: ${interactive.mode}`,
    `model: ${interactive.selectedModel ?? "default"}`,
    `activeRunId: ${session.activeRunId ?? "none"}`,
    `pendingPatch: ${interactive.pendingPatchArtifact ?? "none"}`,
    `lastRunStatus: ${session.lastRunStatus ?? "none"}`,
    `pendingApprovals: ${session.pendingApprovalIds.join(", ") || "none"}`,
  ].join("\n");
}

function renderWelcome(sessionId: string, interactive: InteractiveSessionState): string {
  return `Chat session ${sessionId}. mode=${interactive.mode} model=${interactive.selectedModel ?? "default"}. Use /help for commands.`;
}

function formatPromptLabel(sessionId: string, interactive: InteractiveSessionState): string {
  return `little-helper:${interactive.mode}:${sessionId.slice(-8)}> `;
}

function createSyntheticTurnId(prefix: string, runId: string): string {
  return `${prefix}-${runId}`;
}

function resolveInteractiveSettings(base: Settings, interactive: InteractiveSessionState): Settings {
  return {
    ...base,
    llmModel: interactive.selectedModel ?? base.llmModel,
  };
}

function parseMode(value: string): OperatorMode {
  if (value === "suggest" || value === "auto-edit" || value === "full-auto") {
    return value;
  }
  throw new AppError("VALIDATION_ERROR", `Invalid mode: ${value}`);
}

async function renderDiffSummary(artifactDir: string, runId: string): Promise<string> {
  const artifactsDir = path.join(artifactDir, runId, "artifacts");
  const files = await readdir(artifactsDir);
  const patches = files.filter((file) => file.endsWith(".patch")).sort();
  let changedFilesSummary = "changed files: none";
  try {
    const changedFiles = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(artifactDir, runId, "changed-files.json"), "utf8")) as string[];
    changedFilesSummary = `changed files: ${changedFiles.join(", ") || "none"}`;
  } catch {
    changedFilesSummary = "changed files: none";
  }
  return [changedFilesSummary, patches.length > 0 ? `patch artifacts:\n${patches.join("\n")}` : "patch artifacts: none"].join("\n\n");
}

async function renderReviewSummary(artifactDir: string, runId: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const evaluationPath = path.join(artifactDir, runId, "evaluation.json");
  const finalPath = path.join(artifactDir, runId, "final-report.md");
  const lines: string[] = [`run: ${runId}`];
  try {
    const evaluation = JSON.parse(await fs.readFile(evaluationPath, "utf8")) as {
      status?: string;
      failedCriteria?: string[];
      requiredRevisions?: string[];
    };
    lines.push(`evaluation: ${evaluation.status ?? "unknown"}`);
    if ((evaluation.failedCriteria?.length ?? 0) > 0) {
      lines.push(`failed criteria: ${evaluation.failedCriteria?.join("; ")}`);
    }
    if ((evaluation.requiredRevisions?.length ?? 0) > 0) {
      lines.push(`required revisions: ${evaluation.requiredRevisions?.join("; ")}`);
    }
  } catch {
    lines.push("evaluation: unavailable");
  }
  try {
    const report = await fs.readFile(finalPath, "utf8");
    lines.push("");
    lines.push(report.trim());
  } catch {
    lines.push("");
    lines.push("final report: unavailable");
  }
  return lines.join("\n");
}

async function defaultLoadSettings(cwd: string, options: Record<string, unknown>): Promise<Settings> {
  const { loadSettings } = await import("../config.js");
  return loadSettings(cwd, {
    ...(typeof options.artifactDir === "string" ? { artifactDir: options.artifactDir } : {}),
    ...(typeof options.approvalMode === "string" ? { approvalMode: options.approvalMode as ApprovalMode } : {}),
    ...(typeof options.maxIterations === "number" ? { maxIterations: options.maxIterations } : {}),
    outputFormat: options.outputFormat === "json" ? "json" : "text",
    stream: typeof options.stream === "boolean" ? options.stream : true,
  });
}

function defaultCreateOrchestrator(
  settings: Settings,
  logger: Logger,
  onEvent?: (event: TelemetryEvent) => void,
): Orchestrator {
  return new Orchestrator(settings, logger, onEvent ? { onEvent } : {});
}
