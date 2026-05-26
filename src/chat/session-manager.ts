import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ApprovalManager } from "../harness/approvals.js";
import { RunStore, createRunId } from "../memory/run-store.js";
import {
  ChatSessionStateSchema,
  ChatTurnRecordSchema,
  InteractiveSessionStateSchema,
  type ApprovalRequest,
  type ChatSessionState,
  type ChatTurnRecord,
  type HarnessStatus,
  type InteractiveSessionState,
  type LLMProvider,
  type OperatorMode,
  type RunRequest,
} from "../schemas.js";

const DEFAULT_COMPACTION_THRESHOLD = 2_400;
const DEFAULT_RECENT_TURN_LIMIT = 6;

export interface PendingSessionApproval extends ApprovalRequest {
  runId: string;
}

export interface CreateChatSessionInput {
  workingDirectory: string;
  mode?: OperatorMode;
  selectedProvider?: LLMProvider;
  selectedModel?: string;
}

export interface PrepareChatTurnInput {
  sessionId: string;
  message: string;
  profile: string;
  dryRun: boolean;
  maxIterations: number;
}

export interface PreparedChatTurn {
  session: ChatSessionState;
  interactive: InteractiveSessionState;
  turnId: string;
  request: RunRequest;
}

export interface CompleteChatTurnInput {
  sessionId: string;
  turnId: string;
  runId: string;
  assistantContent: string;
  assistantSummary: string;
  artifactRefs: string[];
  runStatus: HarnessStatus;
  latestTokenUsageLine?: string;
}

export interface FailChatTurnInput {
  sessionId: string;
  assistantContent: string;
  assistantSummary: string;
}

export class ChatSessionManager {
  public constructor(
    private readonly artifactDir: string,
    private readonly options: {
      compactionThresholdChars?: number;
      recentTurnLimit?: number;
      now?: () => Date;
    } = {},
  ) {}

  public async createSession(input: CreateChatSessionInput): Promise<ChatSessionState> {
    const now = this.timestamp();
    const session = ChatSessionStateSchema.parse({
      sessionId: createRunId(this.now()),
      createdAt: now,
      updatedAt: now,
      workingDirectory: path.resolve(input.workingDirectory),
      status: "idle",
      turns: 0,
      conversationSummary: "",
      pendingApprovalIds: [],
    });
    await this.ensureSessionDirectory(session.sessionId);
    await this.persistSession(session);
    await this.persistInteractiveState(
      InteractiveSessionStateSchema.parse({
        sessionId: session.sessionId,
        updatedAt: now,
        mode: input.mode ?? "suggest",
        ...(input.selectedProvider ? { selectedProvider: input.selectedProvider } : {}),
        ...(input.selectedModel ? { selectedModel: input.selectedModel } : {}),
        recentActivitySummary: "",
      }),
    );
    await this.writeSummary(session.sessionId, "");
    return session;
  }

  public async loadSession(sessionId: string): Promise<ChatSessionState> {
    const raw = await readFile(this.resolveSessionFile(sessionId), "utf8");
    return ChatSessionStateSchema.parse(JSON.parse(raw));
  }

  public async loadInteractiveState(sessionId: string): Promise<InteractiveSessionState> {
    const raw = await readFile(this.resolveInteractiveStateFile(sessionId), "utf8");
    return InteractiveSessionStateSchema.parse(JSON.parse(raw));
  }

  public async listSessions(): Promise<string[]> {
    const root = path.join(this.artifactDir, "chat");
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  }

  public async listTurns(sessionId: string): Promise<ChatTurnRecord[]> {
    try {
      const raw = await readFile(this.resolveTurnsFile(sessionId), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => ChatTurnRecordSchema.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }

  public async listRunIds(sessionId: string): Promise<string[]> {
    const turns = await this.listTurns(sessionId);
    return [...new Set(turns.flatMap((turn) => (turn.runId ? [turn.runId] : [])))];
  }

  public async prepareTurn(input: PrepareChatTurnInput): Promise<PreparedChatTurn> {
    const session = await this.refreshSession(input.sessionId);
    const interactive = await this.loadInteractiveState(input.sessionId);
    const timestamp = this.timestamp();
    const turnId = createRunId(this.now());
    const trimmed = input.message.trim();
    const userTurn = ChatTurnRecordSchema.parse({
      turnId,
      role: "user",
      content: trimmed,
      timestamp,
      artifactRefs: [],
      summary: summarizeContent(trimmed),
    });
    await this.appendTurnRecord(session.sessionId, userTurn);
    const updatedSession = await this.recomputeSession(session.sessionId, {
      status: "running",
      activeRunId: undefined,
      lastRunStatus: session.lastRunStatus,
    });
    await this.persistInteractiveState({
      ...interactive,
      updatedAt: this.timestamp(),
      activeRunId: undefined,
      pendingPatchArtifact: undefined,
      recentActivitySummary: summarizeContent(trimmed),
    });
    const context = await this.buildConversationContext(updatedSession.sessionId, turnId, trimmed);
    const request = {
      task: trimmed,
      workingDirectory: updatedSession.workingDirectory,
      profile: input.profile,
      dryRun: input.dryRun,
      maxIterations: input.maxIterations,
      selectedSkills: [],
      metadata: {
        sessionId: updatedSession.sessionId,
        turnId,
        sessionMode: interactive.mode,
        ...(interactive.selectedProvider ? { selectedProvider: interactive.selectedProvider } : {}),
        ...(interactive.selectedModel ? { selectedModel: interactive.selectedModel } : {}),
      },
      conversationContext: context,
    } satisfies RunRequest;
    return {
      session: updatedSession,
      interactive: interactive,
      turnId,
      request,
    };
  }

  public async completeTurn(input: CompleteChatTurnInput): Promise<ChatSessionState> {
    const assistantTurn = ChatTurnRecordSchema.parse({
      turnId: createRunId(this.now()),
      role: "assistant",
      content: input.assistantContent,
      timestamp: this.timestamp(),
      runId: input.runId,
      artifactRefs: input.artifactRefs,
      summary: input.assistantSummary,
    });
    await this.appendTurnRecord(input.sessionId, assistantTurn);
    const session = await this.recomputeSession(input.sessionId, {
      status: deriveSessionStatus(input.runStatus),
      activeRunId:
        input.runStatus === "awaiting_approval" || input.runStatus === "blocked" ? input.runId : undefined,
      lastRunStatus: input.runStatus,
    });
    const interactive = await this.loadInteractiveState(input.sessionId);
    await this.persistInteractiveState({
      ...interactive,
      updatedAt: this.timestamp(),
      activeRunId:
        input.runStatus === "awaiting_approval" || input.runStatus === "blocked" ? input.runId : undefined,
      pendingPatchArtifact: await this.findPendingPatchArtifact(input.sessionId, input.runId),
      recentActivitySummary: summarizeContent(input.assistantSummary),
      ...(input.latestTokenUsageLine
        ? { latestTokenUsageLine: input.latestTokenUsageLine }
        : {}),
    });
    return session;
  }

  public async failTurn(input: FailChatTurnInput): Promise<ChatSessionState> {
    const assistantTurn = ChatTurnRecordSchema.parse({
      turnId: createRunId(this.now()),
      role: "assistant",
      content: input.assistantContent,
      timestamp: this.timestamp(),
      artifactRefs: [],
      summary: input.assistantSummary,
    });
    await this.appendTurnRecord(input.sessionId, assistantTurn);
    const session = await this.recomputeSession(input.sessionId, {
      status: "idle",
      activeRunId: undefined,
    });
    const interactive = await this.loadInteractiveState(input.sessionId);
    await this.persistInteractiveState({
      ...interactive,
      updatedAt: this.timestamp(),
      activeRunId: undefined,
      pendingPatchArtifact: undefined,
      recentActivitySummary: summarizeContent(input.assistantSummary),
    });
    return session;
  }

  public async recordSystemTurn(sessionId: string, content: string, summary?: string): Promise<ChatSessionState> {
    const turn = ChatTurnRecordSchema.parse({
      turnId: createRunId(this.now()),
      role: "system",
      content,
      timestamp: this.timestamp(),
      artifactRefs: [],
      ...(summary ? { summary } : {}),
    });
    await this.appendTurnRecord(sessionId, turn);
    const interactive = await this.loadInteractiveState(sessionId);
    await this.persistInteractiveState({
      ...interactive,
      updatedAt: this.timestamp(),
      recentActivitySummary: summarizeContent(summary ?? content),
    });
    return this.recomputeSession(sessionId, {});
  }

  public async refreshSession(sessionId: string): Promise<ChatSessionState> {
    const session = await this.recomputeSession(sessionId, {});
    const interactive = await this.loadInteractiveState(sessionId);
    await this.persistInteractiveState({
      ...interactive,
      updatedAt: this.timestamp(),
      activeRunId: session.activeRunId,
      pendingPatchArtifact: await this.findPendingPatchArtifact(sessionId, session.activeRunId),
    });
    return session;
  }

  public async setMode(sessionId: string, mode: OperatorMode): Promise<InteractiveSessionState> {
    const current = await this.loadInteractiveState(sessionId);
    const next = InteractiveSessionStateSchema.parse({
      ...current,
      updatedAt: this.timestamp(),
      mode,
    });
    await this.persistInteractiveState(next);
    return next;
  }

  public async setSelectedProvider(
    sessionId: string,
    selectedProvider?: LLMProvider,
  ): Promise<InteractiveSessionState> {
    const current = await this.loadInteractiveState(sessionId);
    const next = InteractiveSessionStateSchema.parse({
      ...current,
      updatedAt: this.timestamp(),
      ...(selectedProvider ? { selectedProvider } : { selectedProvider: undefined }),
    });
    await this.persistInteractiveState(next);
    return next;
  }

  public async setSelectedModel(sessionId: string, selectedModel?: string): Promise<InteractiveSessionState> {
    const current = await this.loadInteractiveState(sessionId);
    const next = InteractiveSessionStateSchema.parse({
      ...current,
      updatedAt: this.timestamp(),
      ...(selectedModel ? { selectedModel } : { selectedModel: undefined }),
    });
    await this.persistInteractiveState(next);
    return next;
  }

  public async listPendingApprovals(sessionId: string): Promise<PendingSessionApproval[]> {
    const runStore = new RunStore(this.artifactDir);
    const approvals = await Promise.all(
      (await this.listRunIds(sessionId)).map(async (runId) => {
        const manager = new ApprovalManager(runStore.createArtifactStore(runId));
        const records = await manager.load();
        return records
          .filter((approval) => approval.status === "pending")
          .map((approval) => ({ ...approval, runId }));
      }),
    );
    return approvals.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async decideApproval(
    sessionId: string,
    approvalId: string,
    status: "approved" | "denied",
  ): Promise<PendingSessionApproval | undefined> {
    const runStore = new RunStore(this.artifactDir);
    for (const runId of await this.listRunIds(sessionId)) {
      const artifactStore = runStore.createArtifactStore(runId);
      const manager = new ApprovalManager(artifactStore);
      await manager.load();
      const updated = await manager.decide(approvalId, status);
      if (updated) {
        await this.recomputeSession(sessionId, {});
        const interactive = await this.loadInteractiveState(sessionId);
        await this.persistInteractiveState({
          ...interactive,
          updatedAt: this.timestamp(),
          pendingPatchArtifact: await this.findPendingPatchArtifact(sessionId, runId),
          recentActivitySummary: `${status} approval ${approvalId}`,
        });
        return {
          ...updated,
          runId,
        };
      }
    }
    return undefined;
  }

  public async buildConversationContext(
    sessionId: string,
    turnId: string,
    latestUserMessage: string,
  ): Promise<NonNullable<RunRequest["conversationContext"]>> {
    const session = await this.loadSession(sessionId);
    const turns = await this.listTurns(sessionId);
    const recentTurns = turns.slice(-this.recentTurnLimit()).map((turn) => ChatTurnRecordSchema.parse(turn));
    const lastAssistantSummary = [...turns]
      .reverse()
      .find((turn) => turn.role === "assistant" && typeof turn.summary === "string")?.summary;
    const includedArtifactRefs = [...new Set(recentTurns.flatMap((turn) => turn.artifactRefs))];
    return {
      sessionId,
      turnId,
      latestUserMessage,
      conversationSummary: session.conversationSummary,
      ...(lastAssistantSummary ? { lastAssistantSummary } : {}),
      recentTurns,
      includedArtifactRefs,
    };
  }

  public resolveSessionDirectory(sessionId: string): string {
    return path.join(this.artifactDir, "chat", sessionId);
  }

  private async recomputeSession(
    sessionId: string,
    overrides: Partial<Pick<ChatSessionState, "status" | "activeRunId" | "lastRunStatus">>,
  ): Promise<ChatSessionState> {
    const current = await this.loadSession(sessionId);
    const turns = await this.listTurns(sessionId);
    const pendingApprovals = await this.listPendingApprovals(sessionId);
    const conversationSummary = buildConversationSummary(
      turns,
      current.conversationSummary,
      this.compactionThreshold(),
      this.recentTurnLimit(),
    );
    const next = ChatSessionStateSchema.parse({
      ...current,
      updatedAt: this.timestamp(),
      turns: turns.length,
      conversationSummary,
      pendingApprovalIds: pendingApprovals.map((approval) => approval.id),
      status:
        pendingApprovals.length > 0
          ? "awaiting_approval"
          : (overrides.status ?? current.status) === "awaiting_approval"
            ? "idle"
            : (overrides.status ?? current.status),
      activeRunId:
        pendingApprovals.length > 0
          ? overrides.activeRunId ?? current.activeRunId
          : overrides.activeRunId ?? undefined,
      lastRunStatus: overrides.lastRunStatus ?? current.lastRunStatus,
    });
    await this.persistSession(next);
    await this.writeSummary(sessionId, conversationSummary);
    return next;
  }

  private async appendTurnRecord(sessionId: string, turn: ChatTurnRecord): Promise<void> {
    await this.ensureSessionDirectory(sessionId);
    await writeFile(this.resolveTurnsFile(sessionId), `${JSON.stringify(turn)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  private async persistSession(session: ChatSessionState): Promise<void> {
    await this.ensureSessionDirectory(session.sessionId);
    await writeFile(this.resolveSessionFile(session.sessionId), JSON.stringify(session, null, 2), "utf8");
  }

  private async persistInteractiveState(state: InteractiveSessionState): Promise<void> {
    await this.ensureSessionDirectory(state.sessionId);
    await writeFile(this.resolveInteractiveStateFile(state.sessionId), JSON.stringify(state, null, 2), "utf8");
  }

  private async writeSummary(sessionId: string, summary: string): Promise<void> {
    const rendered =
      summary.length > 0 ? `# Conversation Summary\n\n${summary}\n` : "# Conversation Summary\n\n_No summary yet._\n";
    await writeFile(this.resolveSummaryFile(sessionId), rendered, "utf8");
  }

  private async ensureSessionDirectory(sessionId: string): Promise<void> {
    await mkdir(this.resolveSessionDirectory(sessionId), { recursive: true });
  }

  private resolveSessionFile(sessionId: string): string {
    return path.join(this.resolveSessionDirectory(sessionId), "session.json");
  }

  private resolveInteractiveStateFile(sessionId: string): string {
    return path.join(this.resolveSessionDirectory(sessionId), "interactive-session.json");
  }

  private resolveTurnsFile(sessionId: string): string {
    return path.join(this.resolveSessionDirectory(sessionId), "turns.jsonl");
  }

  private resolveSummaryFile(sessionId: string): string {
    return path.join(this.resolveSessionDirectory(sessionId), "summary.md");
  }

  private async findPendingPatchArtifact(sessionId: string, preferredRunId?: string): Promise<string | undefined> {
    const runIds = preferredRunId ? [preferredRunId] : await this.listRunIds(sessionId);
    for (const runId of [...runIds].reverse()) {
      const artifactsDir = path.join(this.artifactDir, runId, "artifacts");
      try {
        const files = await readdir(artifactsDir);
        const match = files
          .filter((file) => file.endsWith("-proposed.patch"))
          .sort()
          .at(-1);
        if (match) {
          return path.join(artifactsDir, match);
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private compactionThreshold(): number {
    return this.options.compactionThresholdChars ?? DEFAULT_COMPACTION_THRESHOLD;
  }

  private recentTurnLimit(): number {
    return this.options.recentTurnLimit ?? DEFAULT_RECENT_TURN_LIMIT;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function deriveSessionStatus(runStatus: HarnessStatus): ChatSessionState["status"] {
  if (runStatus === "awaiting_approval") {
    return "awaiting_approval";
  }
  if (runStatus === "blocked" || runStatus === "failed") {
    return "blocked";
  }
  return "idle";
}

function buildConversationSummary(
  turns: ChatTurnRecord[],
  previousSummary: string,
  thresholdChars: number,
  recentTurnLimit: number,
): string {
  const transcript = turns
    .map((turn) => `${turn.role}: ${turn.summary ?? summarizeContent(turn.content)}`)
    .join("\n");
  if (transcript.length <= thresholdChars) {
    return previousSummary;
  }
  const compactedTurns = turns.slice(0, Math.max(0, turns.length - recentTurnLimit));
  const summaryLines = compactedTurns.map((turn) => `- ${turn.role}: ${turn.summary ?? summarizeContent(turn.content)}`);
  return summaryLines.join("\n");
}

function summarizeContent(content: string, maxLength = 160): string {
  const normalized = content.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
