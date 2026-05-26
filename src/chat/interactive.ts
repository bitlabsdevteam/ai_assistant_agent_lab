import { createInterface } from "node:readline/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { Logger } from "pino";

import { applyWorkspaceEnvToProcess } from "../env.js";
import { AppError } from "../errors.js";
import { bindProcessEscape, runWithEscapeCancellation } from "../interrupts.js";
import { ApprovalManager } from "../harness/approvals.js";
import type { RunResult } from "../harness/controller.js";
import type { LLMStreamEvent } from "../llm/client.js";
import { createLogger } from "../logger.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import { tokenizeArgv } from "../commands/argv.js";
import { addMCPServerConfig } from "../mcp/config-manager.js";
import {
  buildMCPServerConfig,
  parseMCPAddArgv,
  renderMCPAddResult,
  renderMCPCommandHelp,
  renderMCPDiscovery,
  renderMCPDiscoveryList,
} from "../mcp/commands.js";
import { Orchestrator } from "../orchestrator.js";
import { createRuntimeTextRenderer } from "../rendering/runtime-output.js";
import {
  parseSkillsAddArgv,
  renderSkillAddResult,
  renderSkillsCommandHelp,
  renderSkillInspect,
  renderSkillList,
  renderSkillValidation,
} from "../skills/commands.js";
import { addSkill, discoverSkillCatalog, getSkillByName, validateSkillCatalog } from "../skills/registry.js";
import {
  ChatEventSchema,
  LLMUsageTelemetryDetailsSchema,
  type ApprovalMode,
  type ChatEvent,
  type ChatSessionStatus,
  type HarnessStatus,
  type InteractiveSessionState,
  type LLMUsageTelemetryDetails,
  type OperatorMode,
  type OutputFormat,
  type Settings,
  type TelemetryEvent,
} from "../schemas.js";
import { ToolRegistry } from "../tools/registry.js";
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
  write(text: string): void;
  writeLine(line: string): void;
  bindEscape?(onEscape: () => void): () => void;
  close(): Promise<void>;
}

export interface ChatRuntimeDependencies {
  loadSettings: (cwd: string, options: Record<string, unknown>) => Promise<Settings>;
  createOrchestrator: (
    settings: Settings,
    logger: Logger,
    onEvent?: (event: TelemetryEvent) => void,
    onLLMEvent?: (event: LLMStreamEvent) => void,
  ) => Orchestrator;
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
      'The "chat" command requires an interactive TTY. Use `argus run "TASK"` for non-interactive automation.',
    );
  }
  if (options.resume && options.new) {
    throw new AppError("VALIDATION_ERROR", "Choose either --resume or --new, not both.");
  }

  const loadSettings = dependencies.loadSettings ?? defaultLoadSettings;
  let baseSettings = await loadSettings(options.cwd, {
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
      const label =
        baseSettings.outputFormat === "json" ? "" : formatPromptLabel(session.sessionId, interactive, session.status);
      const input = (await consoleAdapter.prompt(label)).trim();
      if (input.length === 0) {
        continue;
      }
      let activeTurnRenderer: ReturnType<typeof createRuntimeTextRenderer> | undefined;
      try {
        const approvalContinuation = await maybeHandleApprovalReply(input, {
          session,
          interactive,
          sessionManager,
          console: consoleAdapter,
          settings: baseSettings,
          logger,
          createOrchestrator,
        });
        if (approvalContinuation) {
          session = approvalContinuation.session;
          interactive = approvalContinuation.interactive;
          continue;
        }

        if (input.startsWith("/")) {
          const next = await handleCommand(input, {
            session,
            interactive,
            sessionManager,
            console: consoleAdapter,
            settings: baseSettings,
            reloadSettings: async () =>
              loadSettings(options.cwd, {
                cwd: options.cwd,
                artifactDir: options.artifactDir,
                approvalMode: options.approvalMode,
                maxIterations: options.maxIterations,
                outputFormat: options.output,
                stream: options.stream,
              }),
            logger,
            createOrchestrator,
          });
          if (next === "exit") {
            break;
          }
          session = next.session;
          interactive = next.interactive;
          baseSettings = next.settings;
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
        const llmStreamRenderer = createRuntimeTextRenderer(consoleAdapter, sessionSettings.outputFormat, {
          textMode: "assistant",
        });
        activeTurnRenderer = llmStreamRenderer;
        let latestTokenUsageLine: string | undefined;
        const onTelemetryEvent = (event: TelemetryEvent) => {
          const parsedUsage =
            event.event === "llm.usage.updated" ? LLMUsageTelemetryDetailsSchema.safeParse(event.details) : undefined;
          if (parsedUsage?.success) {
            latestTokenUsageLine = formatPersistentTokenUsage(parsedUsage.data);
          }
          if (sessionSettings.stream) {
            llmStreamRenderer.onEvent(event);
          }
        };
        const orchestrator = createOrchestrator(
          sessionSettings,
          logger,
          onTelemetryEvent,
          sessionSettings.stream ? llmStreamRenderer.onLLMEvent : undefined,
        );
        const result = await runWithEscapeCancellation(
          {
            outputFormat: sessionSettings.outputFormat,
            enabled: consoleAdapter.isTTY(),
            writer: consoleAdapter,
            bindEscape: (onEscape) => consoleAdapter.bindEscape?.(onEscape) ?? bindProcessEscape(onEscape),
          },
          (signal) => orchestrator.run(prepared.request, { signal }),
        );
        const pendingApprovals =
          result.state.status === "awaiting_approval"
            ? await loadPendingRunApprovals(sessionSettings.artifactDir, result.state.runId)
            : [];
        const reply = buildAssistantReply(result, pendingApprovals);
        const replySummary = buildAssistantSummary(result.state.status, result.state.runId, {
          executionSummary: result.execution?.summary,
          evaluationStatus: result.evaluation?.status,
        });
        session = await sessionManager.completeTurn({
          sessionId: session.sessionId,
          turnId: prepared.turnId,
          runId: result.state.runId,
          assistantContent: reply,
          assistantSummary: replySummary,
          artifactRefs: collectRunArtifacts(result.state),
          runStatus: result.state.status,
          ...(latestTokenUsageLine ? { latestTokenUsageLine } : {}),
        });
        interactive = await sessionManager.loadInteractiveState(session.sessionId);
        llmStreamRenderer.finish();
        writeAssistantReply(llmStreamRenderer, sessionSettings.outputFormat, reply, result.state.runId, {
          summary: replySummary,
          omitBody: llmStreamRenderer.hasStreamedAssistantContent(),
          streamBody: sessionSettings.stream,
          suppressWhenOmitted: true,
        });
        emitChatEvent(consoleAdapter, sessionSettings.outputFormat, {
          type: "chat.turn_completed",
          timestamp: new Date().toISOString(),
          sessionId: session.sessionId,
          turnId: prepared.turnId,
          runId: result.state.runId,
          status: result.state.status,
        });
        if (result.state.status === "awaiting_approval" && sessionSettings.outputFormat === "text" && pendingApprovals.length > 1) {
          const pending = pendingApprovals.length > 0 ? pendingApprovals : await sessionManager.listPendingApprovals(session.sessionId);
          llmStreamRenderer.writeLine(renderPendingApprovals(pending));
        }
      } catch (error) {
        const message = formatChatError(error);
        activeTurnRenderer?.finish();
        if (!input.startsWith("/")) {
          session = await sessionManager.failTurn({
            sessionId: session.sessionId,
            assistantContent: message,
            assistantSummary: message,
          });
          interactive = await sessionManager.loadInteractiveState(session.sessionId);
        }
        writeChatError(activeTurnRenderer ?? consoleAdapter, baseSettings.outputFormat, message);
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

  public write(text: string): void {
    process.stdout.write(text);
  }

  public bindEscape(onEscape: () => void): () => void {
    return bindProcessEscape(onEscape);
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
    reloadSettings: () => Promise<Settings>;
    logger: Logger;
    createOrchestrator: (
      settings: Settings,
      logger: Logger,
      onEvent?: (event: TelemetryEvent) => void,
      onLLMEvent?: (event: LLMStreamEvent) => void,
    ) => Orchestrator;
  },
): Promise<{ session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>; interactive: InteractiveSessionState; settings: Settings } | "exit"> {
  const [command, ...args] = tokenizeArgv(input);
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
      return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
    case "/status": {
      const session = await dependencies.sessionManager.refreshSession(dependencies.session.sessionId);
      const interactive = await dependencies.sessionManager.loadInteractiveState(session.sessionId);
      dependencies.console.writeLine(renderStatus(session, interactive));
      return { session, interactive, settings: dependencies.settings };
    }
    case "/sessions": {
      const sessions = await dependencies.sessionManager.listSessions();
      dependencies.console.writeLine(sessions.length > 0 ? sessions.join("\n") : "No chat sessions yet.");
      return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
    }
    case "/runs": {
      const runIds = await dependencies.sessionManager.listRunIds(dependencies.session.sessionId);
      dependencies.console.writeLine(runIds.length > 0 ? runIds.join("\n") : "No runs yet.");
      return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
    }
    case "/mcp": {
      const subcommand = args[0];
      if (!subcommand) {
        dependencies.console.writeLine(renderMCPCommandHelp());
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }

      if (subcommand === "list") {
        const registry = await ToolRegistry.create(dependencies.settings);
        dependencies.console.writeLine(renderMCPDiscoveryList(registry.listMCPServers()));
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }

      if (subcommand === "inspect") {
        const serverName = args[1];
        if (!serverName) {
          throw new AppError("VALIDATION_ERROR", "Usage: /mcp inspect <serverName>");
        }
        const registry = await ToolRegistry.create(dependencies.settings);
        dependencies.console.writeLine(renderMCPDiscovery(registry.getMCPServer(serverName)));
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }

      if (subcommand === "add") {
        const addInput = parseMCPAddArgv(args.slice(1));
        const result = await addMCPServerConfig({
          workingDirectory: dependencies.session.workingDirectory,
          scope: addInput.scope,
          server: buildMCPServerConfig(addInput),
          settings: dependencies.settings,
        });
        const reloadedSettings = await dependencies.reloadSettings();
        dependencies.console.writeLine(renderMCPAddResult(result));
        return { session: dependencies.session, interactive: dependencies.interactive, settings: reloadedSettings };
      }

      throw new AppError("VALIDATION_ERROR", `Unknown MCP command: ${subcommand}. Use /mcp for help.`);
    }
    case "/skills": {
      const subcommand = args[0];
      if (!subcommand) {
        dependencies.console.writeLine(renderSkillsCommandHelp());
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }

      if (subcommand === "list") {
        const catalog = await discoverSkillCatalog(dependencies.settings);
        dependencies.console.writeLine(renderSkillList(catalog.skills, dependencies.settings.outputFormat));
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }

      if (subcommand === "inspect") {
        const skillName = args[1];
        if (!skillName) {
          throw new AppError("VALIDATION_ERROR", "Usage: /skills inspect <name>");
        }
        const skill = await getSkillByName(dependencies.settings, skillName);
        if (!skill) {
          throw new AppError("NOT_FOUND", `Skill not found: ${skillName}`);
        }
        dependencies.console.writeLine(renderSkillInspect(skill, dependencies.settings.outputFormat));
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }

      if (subcommand === "validate") {
        const report = await validateSkillCatalog(dependencies.settings);
        dependencies.console.writeLine(renderSkillValidation(report, dependencies.settings.outputFormat));
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }

      if (subcommand === "add") {
        const parsed = parseSkillsAddArgv(args.slice(1));
        const result = await addSkill({
          workingDirectory: dependencies.session.workingDirectory,
          settings: dependencies.settings,
          scope: parsed.scope,
          name: parsed.name,
          triggers: parsed.triggers,
          tags: parsed.tags,
          tools: parsed.tools,
          enabled: !parsed.disabled,
          ...(parsed.description ? { description: parsed.description } : {}),
          ...(parsed.from ? { from: parsed.from } : {}),
        });
        const reloadedSettings = await dependencies.reloadSettings();
        dependencies.console.writeLine(renderSkillAddResult(result, dependencies.settings.outputFormat));
        return { session: dependencies.session, interactive: dependencies.interactive, settings: reloadedSettings };
      }

      throw new AppError("VALIDATION_ERROR", `Unknown skills command: ${subcommand}. Use /skills for help.`);
    }
    case "/resume": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /resume <runId>");
      }
      await dependencies.sessionManager.recordSystemTurn(dependencies.session.sessionId, input, `Resume run ${runId}`);
      const resumed = await resumeRunInChat(runId, dependencies, createSyntheticTurnId("resume", runId));
      return { ...resumed, settings: dependencies.settings };
    }
    case "/approvals": {
      const approvals = await dependencies.sessionManager.listPendingApprovals(dependencies.session.sessionId);
      dependencies.console.writeLine(renderPendingApprovals(approvals));
      return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
    }
    case "/approve":
    case "/deny": {
      const decision = command === "/approve" ? "approved" : "denied";
      const decided = await decideApprovalInChat(args[0], decision, dependencies, input);
      return { ...decided, settings: dependencies.settings };
    }
    case "/diff": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /diff <runId>");
      }
      dependencies.console.writeLine(await renderDiffSummary(dependencies.settings.artifactDir, runId));
      return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
    }
    case "/review": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /review <runId>");
      }
      dependencies.console.writeLine(await renderReviewSummary(dependencies.settings.artifactDir, runId));
      return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
    }
    case "/artifacts": {
      const runId = args[0] ?? dependencies.session.activeRunId;
      if (!runId) {
        throw new AppError("VALIDATION_ERROR", "Usage: /artifacts <runId>");
      }
      const artifactPath = path.join(dependencies.settings.artifactDir, runId);
      const files = await readdir(artifactPath);
      dependencies.console.writeLine(files.sort().join("\n"));
      return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
    }
    case "/model": {
      if (args.length === 0) {
        dependencies.console.writeLine(dependencies.interactive.selectedModel ?? dependencies.settings.llmModel);
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
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
      return { session: dependencies.session, interactive, settings: dependencies.settings };
    }
    case "/mode": {
      if (args.length === 0) {
        dependencies.console.writeLine(`mode: ${dependencies.interactive.mode}`);
        return { session: dependencies.session, interactive: dependencies.interactive, settings: dependencies.settings };
      }
      const modeArg = args[0];
      if (!modeArg) {
        throw new AppError("VALIDATION_ERROR", "Usage: /mode [suggest|auto-edit|full-auto]");
      }
      const mode = parseMode(modeArg);
      const interactive = await dependencies.sessionManager.setMode(dependencies.session.sessionId, mode);
      dependencies.console.writeLine(`mode: ${interactive.mode}`);
      return { session: dependencies.session, interactive, settings: dependencies.settings };
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
      return { session, interactive, settings: dependencies.settings };
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
      return { session: next, interactive, settings: dependencies.settings };
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

async function maybeHandleApprovalReply(
  input: string,
  dependencies: {
    session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>;
    interactive: InteractiveSessionState;
    sessionManager: ChatSessionManager;
    console: ChatConsole;
    settings: Settings;
    logger: Logger;
    createOrchestrator: (
      settings: Settings,
      logger: Logger,
      onEvent?: (event: TelemetryEvent) => void,
      onLLMEvent?: (event: LLMStreamEvent) => void,
    ) => Orchestrator;
  },
): Promise<{ session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>; interactive: InteractiveSessionState } | undefined> {
  const normalized = input.trim().toLowerCase();
  const decision = parseImplicitApprovalDecision(normalized);
  if (!decision) {
    return undefined;
  }
  const pending = await dependencies.sessionManager.listPendingApprovals(dependencies.session.sessionId);
  if (pending.length === 0) {
    return undefined;
  }
  return decideApprovalInChat(undefined, decision, dependencies, input);
}

function parseImplicitApprovalDecision(input: string): "approved" | "denied" | undefined {
  if (/^(approve|approved|yes|y|ok|okay|continue|go ahead|do it|proceed|ship it)([.! ]+.*)?$/i.test(input)) {
    return "approved";
  }
  if (/^(deny|denied|reject|no|n|stop|cancel)([.! ]+.*)?$/i.test(input)) {
    return "denied";
  }
  return undefined;
}

async function decideApprovalInChat(
  approvalId: string | undefined,
  decision: "approved" | "denied",
  dependencies: {
    session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>;
    interactive: InteractiveSessionState;
    sessionManager: ChatSessionManager;
    console: ChatConsole;
    settings: Settings;
    logger: Logger;
    createOrchestrator: (
      settings: Settings,
      logger: Logger,
      onEvent?: (event: TelemetryEvent) => void,
      onLLMEvent?: (event: LLMStreamEvent) => void,
    ) => Orchestrator;
  },
  commandText: string,
): Promise<{ session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>; interactive: InteractiveSessionState }> {
  const target = await resolveApprovalTarget(dependencies.sessionManager, dependencies.session.sessionId, approvalId, dependencies.session.activeRunId);
  const updated = await dependencies.sessionManager.decideApproval(dependencies.session.sessionId, target.id, decision);
  if (!updated) {
    throw new AppError("NOT_FOUND", `Approval request not found: ${target.id}`);
  }
  await dependencies.sessionManager.recordSystemTurn(
    dependencies.session.sessionId,
    commandText,
    `${decision} approval ${target.id}`,
  );
  if (decision === "denied") {
    const session = await dependencies.sessionManager.refreshSession(dependencies.session.sessionId);
    const interactive = await dependencies.sessionManager.loadInteractiveState(session.sessionId);
    dependencies.console.writeLine(`Denied ${target.id} for run ${updated.runId}.`);
    return { session, interactive };
  }
  return resumeRunInChat(updated.runId, dependencies, createSyntheticTurnId("approval", updated.runId));
}

async function resolveApprovalTarget(
  sessionManager: ChatSessionManager,
  sessionId: string,
  approvalId: string | undefined,
  activeRunId?: string,
): Promise<PendingSessionApproval> {
  const pending = await sessionManager.listPendingApprovals(sessionId);
  if (pending.length === 0) {
    throw new AppError("NOT_FOUND", "No pending approvals.");
  }
  if (approvalId) {
    const exact = pending.find((approval) => approval.id === approvalId);
    if (!exact) {
      throw new AppError("NOT_FOUND", `Approval request not found: ${approvalId}`);
    }
    return exact;
  }
  const activeRunPending = activeRunId ? pending.filter((approval) => approval.runId === activeRunId) : [];
  if (activeRunPending.length === 1) {
    return activeRunPending[0]!;
  }
  if (pending.length === 1) {
    return pending[0]!;
  }
  throw new AppError("VALIDATION_ERROR", "Multiple approvals are pending. Use /approvals and then /approve <approvalId>.");
}

async function resumeRunInChat(
  runId: string,
  dependencies: {
    session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>;
    interactive: InteractiveSessionState;
    sessionManager: ChatSessionManager;
    console: ChatConsole;
    settings: Settings;
    logger: Logger;
    createOrchestrator: (
      settings: Settings,
      logger: Logger,
      onEvent?: (event: TelemetryEvent) => void,
      onLLMEvent?: (event: LLMStreamEvent) => void,
    ) => Orchestrator;
  },
  turnId: string,
): Promise<{ session: Awaited<ReturnType<ChatSessionManager["loadSession"]>>; interactive: InteractiveSessionState }> {
  const sessionSettings = resolveInteractiveSettings(dependencies.settings, dependencies.interactive);
  const llmStreamRenderer = createRuntimeTextRenderer(dependencies.console, sessionSettings.outputFormat, {
    textMode: "assistant",
  });
  const orchestrator = dependencies.createOrchestrator(
    sessionSettings,
    dependencies.logger,
    sessionSettings.stream ? llmStreamRenderer.onEvent : undefined,
    sessionSettings.stream ? llmStreamRenderer.onLLMEvent : undefined,
  );
  const result = await runWithEscapeCancellation(
    {
      outputFormat: sessionSettings.outputFormat,
      enabled: dependencies.console.isTTY(),
      writer: dependencies.console,
      bindEscape: (onEscape) => dependencies.console.bindEscape?.(onEscape) ?? bindProcessEscape(onEscape),
    },
    (signal) => orchestrator.resume(runId, { signal }),
  );
  const pendingApprovals =
    result.state.status === "awaiting_approval" ? await loadPendingRunApprovals(sessionSettings.artifactDir, result.state.runId) : [];
  const reply = buildAssistantReply(result, pendingApprovals);
  const replySummary = buildAssistantSummary(result.state.status, result.state.runId, {
    executionSummary: result.execution?.summary,
    evaluationStatus: result.evaluation?.status,
  });
  const session = await dependencies.sessionManager.completeTurn({
    sessionId: dependencies.session.sessionId,
    turnId,
    runId: result.state.runId,
    assistantContent: reply,
    assistantSummary: replySummary,
    artifactRefs: collectRunArtifacts(result.state),
    runStatus: result.state.status,
  });
  const interactive = await dependencies.sessionManager.loadInteractiveState(session.sessionId);
  llmStreamRenderer.finish();
  writeAssistantReply(llmStreamRenderer, sessionSettings.outputFormat, reply, result.state.runId, {
    summary: replySummary,
    omitBody: llmStreamRenderer.hasStreamedAssistantContent(),
    streamBody: sessionSettings.stream,
    suppressWhenOmitted: true,
  });
  if (result.state.status === "awaiting_approval" && sessionSettings.outputFormat === "text" && pendingApprovals.length > 1) {
    llmStreamRenderer.writeLine(renderPendingApprovals(pendingApprovals));
  }
  return { session, interactive };
}

function writeAssistantReply(
  consoleAdapter: Pick<ChatConsole, "write" | "writeLine">,
  outputFormat: OutputFormat,
  reply: string,
  runId: string,
  options?: {
    summary?: string;
    omitBody?: boolean;
    streamBody?: boolean;
    suppressWhenOmitted?: boolean;
  },
): void {
  if (outputFormat === "json") {
    consoleAdapter.writeLine(JSON.stringify({ role: "assistant", runId, content: options?.omitBody ? (options.summary ?? reply) : reply }));
    return;
  }
  if (options?.omitBody && options?.suppressWhenOmitted) {
    return;
  }
  const content = options?.omitBody ? (options.summary ?? reply) : reply;
  if (options?.streamBody) {
    streamReply(consoleAdapter, content);
  } else {
    consoleAdapter.writeLine(content);
  }
}

function writeChatError(consoleAdapter: Pick<ChatConsole, "writeLine">, outputFormat: OutputFormat, message: string): void {
  if (outputFormat === "json") {
    consoleAdapter.writeLine(JSON.stringify({ role: "assistant", error: true, content: message }));
    return;
  }
  consoleAdapter.writeLine(message);
}

function buildAssistantReply(
  result: Pick<RunResult, "state" | "analysis" | "execution" | "evaluation">,
  pendingApprovals: PendingSessionApproval[] = [],
): string {
  if (result.execution?.assistantResponse) {
    return result.execution.assistantResponse;
  }
  if (result.state.status === "awaiting_approval") {
    return buildApprovalReply(result.execution, pendingApprovals);
  }
  if ((result.execution?.blockers.length ?? 0) > 0) {
    return result.execution?.blockers.join(" ") ?? "The run reported a blocker.";
  }
  if (result.evaluation?.status === "needs_revision") {
    return result.evaluation.requiredRevisions[0] ?? buildAssistantSummary(result.state.status, result.state.runId, {
      executionSummary: result.execution?.summary,
      evaluationStatus: result.evaluation?.status,
    });
  }
  return buildAssistantSummary(result.state.status, result.state.runId, {
    executionSummary: result.execution?.summary,
    evaluationStatus: result.evaluation?.status,
  });
}

function buildApprovalReply(
  execution?: Pick<NonNullable<RunResult["execution"]>, "toolCalls" | "blockers">,
  pendingApprovals: PendingSessionApproval[] = [],
): string {
  if (pendingApprovals.length === 1) {
    const approval = pendingApprovals[0]!;
    return [
      `I need approval to ${describeApprovalAction(approval.toolName)} before I can continue.`,
      summarizeApprovalReason(approval.reason),
      renderBinaryApprovalPrompt(approval.toolName),
    ].join(" ");
  }
  if (pendingApprovals.length > 1) {
    return 'I need approval before I can continue. Multiple approvals are pending. Use "/approvals" to review them.';
  }
  const pendingToolCall = execution?.toolCalls
    .slice()
    .reverse()
    .find((record) => record.approvalProvenance === "pending" || record.status === "skipped");
  if (pendingToolCall?.toolName) {
    return `I need approval to ${describeApprovalAction(pendingToolCall.toolName)} before I can continue.`;
  }
  const blocker = execution?.blockers[0];
  if (blocker) {
    return blocker;
  }
  return "I need approval before I can continue with the requested action.";
}

function buildAssistantSummary(
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

function formatChatError(error: unknown): string {
  if (error instanceof AppError) {
    return `Error [${error.code}]: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Error [INTERNAL_ERROR]: ${error.message}`;
  }
  return "Error [INTERNAL_ERROR]: Unknown chat failure.";
}

function streamReply(consoleAdapter: Pick<ChatConsole, "write" | "writeLine">, reply: string): void {
  const tokens = reply.match(/\S+\s*/g) ?? [reply];
  for (const token of tokens) {
    consoleAdapter.write(token);
  }
  consoleAdapter.write("\n");
}

function describeApprovalAction(toolName: string): string {
  if (toolName === "web.search") {
    return "search the web";
  }
  if (toolName === "web.fetch") {
    return "access the web";
  }
  if (toolName === "fs.list") {
    return "inspect the workspace";
  }
  if (toolName === "fs.read") {
    return "read a file";
  }
  if (toolName === "fs.write" || toolName === "patch.apply") {
    return "edit files";
  }
  if (toolName === "shell.exec" || toolName === "validation.run") {
    return "run a command";
  }
  return `use ${toolName}`;
}

function capitalizeSentence(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function summarizeApprovalReason(reason: string): string {
  const normalized = reason.trim();
  if (/network access .* disabled by default/i.test(normalized)) {
    return "Network access needs approval.";
  }
  if (/network target .* not allowlisted/i.test(normalized)) {
    return "External network access needs approval.";
  }
  if (/approval required/i.test(normalized)) {
    return "This action needs approval.";
  }
  if (/suggest mode requires approval/i.test(normalized)) {
    return "Suggest mode needs approval before making changes.";
  }
  if (/auto-edit mode still requires approval/i.test(normalized)) {
    return "This command needs approval in auto-edit mode.";
  }
  return normalized;
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
  if (approvals.length === 1) {
    const approval = approvals[0]!;
    return [
      `Approval requested: ${capitalizeSentence(describeApprovalAction(approval.toolName))}.`,
      summarizeApprovalReason(approval.reason),
      renderBinaryApprovalPrompt(approval.toolName),
    ].join("\n");
  }
  return approvals
    .map(
      (approval) =>
        `${approval.id}: ${capitalizeSentence(describeApprovalAction(approval.toolName))}. ${summarizeApprovalReason(approval.reason)}`,
    )
    .concat('Multiple approvals are pending. Use "/approve <approvalId>" or "/deny <approvalId>".')
    .join("\n");
}

function renderBinaryApprovalPrompt(toolName: string): string {
  if (toolName === "web.search") {
    return "Agent is accessing the web search tool. Yes or No.";
  }
  if (toolName === "web.fetch") {
    return "Agent is accessing the web. Yes or No.";
  }
  return `Agent is trying to ${describeApprovalAction(toolName)}. Yes or No.`;
}

async function loadPendingRunApprovals(artifactDir: string, runId: string): Promise<PendingSessionApproval[]> {
  const manager = new ApprovalManager(new ArtifactStore(artifactDir, runId));
  const approvals = await manager.load();
  return approvals
    .filter((approval) => approval.status === "pending")
    .map((approval) => ({
      ...approval,
      runId,
    }));
}

function renderHelp(): string {
  return [
    "/help",
    "/status",
    "/sessions",
    "/runs",
    "/skills",
    "/skills list",
    "/skills inspect <name>",
    "/skills add <name> [flags]",
    "/skills validate",
    "/mcp",
    "/mcp list",
    "/mcp inspect <serverName>",
    "/mcp add <name> [flags]",
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
    `latestTokenUsage: ${interactive.latestTokenUsageLine ?? "none"}`,
  ].join("\n");
}

function renderWelcome(sessionId: string, interactive: InteractiveSessionState): string {
  const lines = [
    `Chat session ${sessionId}. mode=${interactive.mode} model=${interactive.selectedModel ?? "default"}. Use /help for commands.`,
  ];
  if (interactive.latestTokenUsageLine) {
    lines.push(interactive.latestTokenUsageLine);
  }
  return lines.join("\n");
}

function formatPromptLabel(
  sessionId: string,
  interactive: InteractiveSessionState,
  status?: ChatSessionStatus,
): string {
  const suffix = status === "awaiting_approval" ? " (approval)" : "";
  const prompt = `argus:${interactive.mode}:${sessionId.slice(-8)}${suffix}> `;
  if (!interactive.latestTokenUsageLine) {
    return prompt;
  }
  return `${interactive.latestTokenUsageLine}\n${prompt}`;
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

function formatPersistentTokenUsage(details: LLMUsageTelemetryDetails): string {
  if (details.stage !== "response") {
    return `Context usage: ${Math.round(details.usagePercent)}% (${formatInteger(details.inputTokens)} / ${formatInteger(
      details.contextWindowTokens,
    )} tokens)`;
  }

  const fragments = [
    `Token usage: total=${formatInteger(details.totalTokens)}`,
    `input=${formatInteger(details.inputTokens)}`,
  ];
  if (details.cachedInputTokens > 0) {
    fragments.push(`(+ ${formatInteger(details.cachedInputTokens)} cached)`);
  }
  fragments.push(`output=${formatInteger(details.outputTokens)}`);
  if (details.reasoningOutputTokens > 0) {
    fragments.push(`(reasoning ${formatInteger(details.reasoningOutputTokens)})`);
  }
  return fragments.join(" ");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
  await applyWorkspaceEnvToProcess(cwd);
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
  onLLMEvent?: (event: LLMStreamEvent) => void,
): Orchestrator {
  return new Orchestrator(settings, logger, {
    ...(onEvent ? { onEvent } : {}),
    ...(onLLMEvent ? { onLLMEvent } : {}),
  });
}
