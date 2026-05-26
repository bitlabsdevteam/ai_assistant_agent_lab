import { createRunId } from "../memory/run-store.js";
import type { ChatSessionManager } from "../chat/session-manager.js";
import type {
  HeadlessMessageResponse,
  HeadlessRunResponse,
  HeadlessSessionRecord,
  RunRequest,
} from "../schemas.js";
import {
  HeadlessJobSchema,
  HeadlessMessageCreateInputSchema,
  HeadlessMessageResponseSchema,
  HeadlessRunRecordSchema,
} from "../schemas.js";
import type { JobRepository, MessageRepository, RunRepository, SessionRepository } from "../repositories/base.js";
import { StreamService } from "./stream-service.js";
import { createPublicId, toPublicRunResponse } from "./utils.js";

export class RunService {
  public constructor(
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly runs: RunRepository,
    private readonly jobs: JobRepository,
    private readonly chatSessions: ChatSessionManager,
    private readonly streams: StreamService,
    private readonly options: {
      now?: () => Date;
      streamBasePath?: string;
      maxIterations?: number;
    } = {},
  ) {}

  public async createMessageAndRun(
    tenantId: string,
    sessionId: string,
    input: unknown,
  ): Promise<{ response: HeadlessMessageResponse; runRequest: RunRequest; turnId: string }> {
    let session = await this.requireSession(tenantId, sessionId);
    const parsed = HeadlessMessageCreateInputSchema.parse(input);
    if (parsed.provider !== undefined) {
      await this.chatSessions.setSelectedProvider(sessionId, parsed.provider);
    }
    if (parsed.model !== undefined) {
      await this.chatSessions.setSelectedModel(sessionId, parsed.model);
    }
    if (parsed.provider !== undefined || parsed.model !== undefined) {
      session = await this.sessions.update({
        ...session,
        ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        updatedAt: this.timestamp(),
      });
    }
    const runId = createRunId(this.now());
    const prepared = await this.chatSessions.prepareTurn({
      sessionId,
      message: parsed.content,
      profile: session.profile,
      dryRun: false,
      maxIterations: this.options.maxIterations ?? 3,
    });
    const timestamp = this.timestamp();
    const userMessageId = prepared.turnId;
    await this.messages.create({
      messageId: userMessageId,
      tenantId,
      sessionId,
      role: "user",
      content: parsed.content,
      createdAt: timestamp,
      metadata: parsed.metadata,
      runId,
    });
    const run = await this.runs.create(
      HeadlessRunRecordSchema.parse({
        runId,
        tenantId,
        sessionId,
        userMessageId,
        status: "queued",
        approvalState: "none",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    await this.sessions.update({
      ...session,
      status: "running",
      updatedAt: timestamp,
      activeRunId: runId,
    });
    await this.jobs.enqueue(
      HeadlessJobSchema.parse({
        jobId: createPublicId(),
        tenantId,
        runId,
        sessionId,
        kind: "execute",
        status: "queued",
        request: {
          ...prepared.request,
          maxIterations: prepared.request.maxIterations,
        },
        turnId: prepared.turnId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    await this.streams.publish({
      tenantId,
      sessionId,
      runId,
      type: "message.created",
      data: {
        messageId: userMessageId,
        role: "user",
        content: parsed.content,
      },
    });
    const response = HeadlessMessageResponseSchema.parse({
      messageId: userMessageId,
      runId: run.runId,
      streamUrl: `${this.options.streamBasePath ?? "/v1"}/runs/${run.runId}/stream`,
      status: run.status,
    });
    return { response, runRequest: prepared.request, turnId: prepared.turnId };
  }

  public async getRun(tenantId: string, runId: string): Promise<HeadlessRunResponse | undefined> {
    const run = await this.runs.getById(tenantId, runId);
    return run ? toPublicRunResponse(run) : undefined;
  }

  private async requireSession(tenantId: string, sessionId: string): Promise<HeadlessSessionRecord> {
    const session = await this.sessions.getById(tenantId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
