import { ChatSessionManager } from "../chat/session-manager.js";
import {
  HeadlessSessionCreateInputSchema,
  HeadlessSessionRecordSchema,
  HeadlessSessionResponseSchema,
  HeadlessSessionSummarySchema,
  type HeadlessMessageRecord,
  type HeadlessSessionResponse,
  type HeadlessSessionSummary,
} from "../schemas.js";
import type { MessageRepository, SessionRepository } from "../repositories/base.js";

export class SessionService {
  public constructor(
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly chatSessions: ChatSessionManager,
  ) {}

  public async createSession(tenantId: string, input: unknown): Promise<HeadlessSessionResponse> {
    const parsed = HeadlessSessionCreateInputSchema.parse(input);
    const mode = parsed.mode ?? "full-auto";
    const created = await this.chatSessions.createSession({
      workingDirectory: parsed.workingDirectory,
      mode,
      ...(parsed.provider ? { selectedProvider: parsed.provider } : {}),
      ...(parsed.model ? { selectedModel: parsed.model } : {}),
    });
    const record = await this.sessions.create(
      HeadlessSessionRecordSchema.parse({
      sessionId: created.sessionId,
      tenantId,
      externalUserId: parsed.externalUserId,
      workingDirectory: created.workingDirectory,
      profile: parsed.profile,
      mode,
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      metadata: parsed.metadata,
      status: "idle",
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      pendingApprovalsCount: 0,
      }),
    );
    return HeadlessSessionResponseSchema.parse({
      sessionId: record.sessionId,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.model ? { model: record.model } : {}),
    });
  }

  public async getSession(tenantId: string, sessionId: string): Promise<HeadlessSessionSummary | undefined> {
    const session = await this.sessions.getById(tenantId, sessionId);
    if (!session) {
      return undefined;
    }
    return HeadlessSessionSummarySchema.parse({
      sessionId: session.sessionId,
      externalUserId: session.externalUserId,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.activeRunId ? { activeRunId: session.activeRunId } : {}),
      pendingApprovalsCount: session.pendingApprovalsCount,
      ...(session.provider ? { provider: session.provider } : {}),
      ...(session.model ? { model: session.model } : {}),
      metadata: session.metadata,
    });
  }

  public async listMessages(tenantId: string, sessionId: string): Promise<HeadlessMessageRecord[]> {
    return this.messages.listBySession(tenantId, sessionId);
  }
}
