import type { Logger } from "pino";

import type { ChatSessionManager } from "../chat/session-manager.js";
import type { Orchestrator } from "../orchestrator.js";
import type { RepositoryBundle } from "../repositories/base.js";
import type { ApprovalRequest, HeadlessApprovalRecord, RunRequest, Settings, TelemetryEvent } from "../schemas.js";
import {
  approvalStateFromApprovals,
  buildAssistantReply,
  createPublicId,
  loadRunApprovals,
  mapHarnessStatusToRunStatus,
  splitAssistantText,
} from "./utils.js";
import { StreamService } from "./stream-service.js";

export interface HeadlessWorkerDependencies {
  repositories: RepositoryBundle;
  streams: StreamService;
  chatSessions: ChatSessionManager;
  settings: Settings;
  logger: Logger;
  createOrchestrator: (callbacks: {
    onEvent: (event: TelemetryEvent) => void | Promise<void>;
  }) => Orchestrator;
}

export class HeadlessWorker {
  private readonly workerId = createPublicId();
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly dependencies: HeadlessWorkerDependencies,
    private readonly options: {
      pollIntervalMs?: number;
      leaseDurationMs?: number;
      now?: () => Date;
    } = {},
  ) {}

  public start(): void {
    if (this.timer) {
      return;
    }
    const pollIntervalMs = this.options.pollIntervalMs ?? 25;
    this.timer = setInterval(() => {
      void this.drainOnce();
    }, pollIntervalMs);
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public async drainOnce(): Promise<boolean> {
    const leased = await this.dependencies.repositories.jobs.leaseNext(
      this.workerId,
      this.now(),
      this.options.leaseDurationMs ?? 5_000,
    );
    if (!leased) {
      return false;
    }
    try {
      if (leased.kind === "resume") {
        await this.processResumeJob(leased.runId, leased.tenantId, leased.sessionId);
      } else if (leased.request) {
        await this.processExecuteJob(leased.runId, leased.tenantId, leased.sessionId, leased.request, leased.turnId);
      } else {
        throw new Error(`Execute job ${leased.jobId} is missing a run request.`);
      }
      await this.dependencies.repositories.jobs.complete(leased.jobId, this.workerId, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker failure";
      await this.dependencies.repositories.jobs.fail(leased.jobId, this.workerId, this.now(), message);
      this.dependencies.logger.error({ error }, "headless worker job failed");
    }
    return true;
  }

  private async processExecuteJob(
    runId: string,
    tenantId: string,
    sessionId: string,
    request: RunRequest,
    turnId?: string,
  ): Promise<void> {
    const run = await this.dependencies.repositories.runs.getById(tenantId, runId);
    const session = await this.dependencies.repositories.sessions.getById(tenantId, sessionId);
    if (!run || !session) {
      throw new Error(`Missing run state for ${runId}`);
    }

    await this.dependencies.repositories.runs.update({
      ...run,
      status: "running",
      updatedAt: this.timestamp(),
    });
    await this.dependencies.streams.publish({
      tenantId,
      sessionId,
      runId,
      type: "run.started",
      data: { status: "running" },
    });
    await this.dependencies.streams.publish({
      tenantId,
      sessionId,
      runId,
      type: "run.status_changed",
      data: { status: "running" },
    });

    const orchestrator = this.dependencies.createOrchestrator({
      onEvent: async (event) => {
        await this.handleTelemetryEvent(tenantId, sessionId, runId, event);
      },
    });
    const result = await orchestrator.run(request, { runId });
    const finalizeInput = {
      runId,
      tenantId,
      sessionId,
      result,
      ...(turnId ? { turnId } : {}),
    };
    await this.finalizeRun(finalizeInput);
  }

  private async processResumeJob(runId: string, tenantId: string, sessionId: string): Promise<void> {
    const run = await this.dependencies.repositories.runs.getById(tenantId, runId);
    const session = await this.dependencies.repositories.sessions.getById(tenantId, sessionId);
    if (!run || !session) {
      throw new Error(`Missing run state for ${runId}`);
    }

    await this.dependencies.repositories.runs.update({
      ...run,
      status: "running",
      updatedAt: this.timestamp(),
    });
    await this.dependencies.streams.publish({
      tenantId,
      sessionId,
      runId,
      type: "run.status_changed",
      data: { status: "running", resumed: true },
    });

    const orchestrator = this.dependencies.createOrchestrator({
      onEvent: async (event) => {
        await this.handleTelemetryEvent(tenantId, sessionId, runId, event);
      },
    });
    const result = await orchestrator.resume(runId);
    await this.finalizeRun({
      runId,
      tenantId,
      sessionId,
      result,
    });
  }

  private async finalizeRun(input: {
    runId: string;
    tenantId: string;
    sessionId: string;
    result: Awaited<ReturnType<Orchestrator["run"]>>;
    turnId?: string;
  }): Promise<void> {
    const run = await this.dependencies.repositories.runs.getById(input.tenantId, input.runId);
    const session = await this.dependencies.repositories.sessions.getById(input.tenantId, input.sessionId);
    if (!run || !session) {
      throw new Error(`Missing run/session during finalize for ${input.runId}`);
    }

    const rawApprovals = await loadRunApprovals(this.dependencies.settings.artifactDir, input.runId);
    const approvals = mapApprovals(input.tenantId, input.sessionId, rawApprovals);
    await this.dependencies.repositories.approvals.replaceForRun(input.runId, approvals);

    const reply = buildAssistantReply(input.result, approvals);
    const replySummary = input.result.execution?.summary ?? reply;
    const status = mapHarnessStatusToRunStatus(input.result.state.status);
    const approvalState = approvalStateFromApprovals(approvals);
    const timestamp = this.timestamp();
    const assistantMessageId = createPublicId();

    await this.dependencies.repositories.messages.create({
      messageId: assistantMessageId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      role: "assistant",
      content: reply,
      createdAt: timestamp,
      metadata: {},
      runId: input.runId,
    });

    await this.dependencies.chatSessions.completeTurn({
      sessionId: input.sessionId,
      turnId: input.turnId ?? createPublicId(),
      runId: input.runId,
      assistantContent: reply,
      assistantSummary: replySummary,
      artifactRefs: [],
      runStatus: input.result.state.status,
    });

    await this.dependencies.repositories.runs.update({
      ...run,
      assistantMessageId,
      status,
      summary: input.result.execution?.summary ?? input.result.evaluation?.requiredRevisions[0] ?? replySummary,
      evaluationStatus: input.result.evaluation?.status,
      approvalState,
      assistantReply: reply,
      updatedAt: timestamp,
      ...(input.result.state.status === "failed" || input.result.state.status === "blocked"
        ? { errorMessage: reply }
        : {}),
    });
    await this.dependencies.repositories.sessions.update({
      ...session,
      status,
      updatedAt: timestamp,
      activeRunId: status === "running" ? input.runId : undefined,
      pendingApprovalsCount: approvals.filter((approval) => approval.status === "pending").length,
    });

    for (const chunk of splitAssistantText(reply)) {
      await this.dependencies.streams.publish({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        runId: input.runId,
        type: "assistant.delta",
        data: {
          text: chunk,
        },
      });
    }
    await this.dependencies.streams.publish({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      runId: input.runId,
      type: "assistant.completed",
      data: {
        messageId: assistantMessageId,
        content: reply,
      },
    });

    if (status === "awaiting_approval") {
      await this.dependencies.streams.publish({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        runId: input.runId,
        type: "run.status_changed",
        data: { status },
      });
      for (const approval of approvals.filter((item) => item.status === "pending")) {
        await this.dependencies.streams.publish({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          runId: input.runId,
          type: "approval.required",
          data: serializeApproval(approval),
        });
      }
      return;
    }

    const finalType = status === "completed" ? "run.completed" : "run.failed";
    await this.dependencies.streams.publish({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      runId: input.runId,
      type: finalType,
      data: {
        status,
        summary: input.result.execution?.summary ?? replySummary,
      },
    });
  }

  private async handleTelemetryEvent(
    tenantId: string,
    sessionId: string,
    runId: string,
    event: TelemetryEvent,
  ): Promise<void> {
    if (event.event === "agent.started" || event.event === "agent.completed") {
      const agent = typeof event.details?.agent === "string" ? event.details.agent : undefined;
      if (!agent) {
        return;
      }
      await this.dependencies.streams.publish({
        tenantId,
        sessionId,
        runId,
        type: event.event === "agent.started" ? "agent.started" : "agent.completed",
        data: {
          agent,
          phase: event.details?.phase,
          iteration: event.details?.iteration,
        },
      });
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function mapApprovals(
  tenantId: string,
  sessionId: string,
  approvals: ApprovalRequest[],
): HeadlessApprovalRecord[] {
  return approvals.map((approval) => ({
    approvalId: approval.id,
    tenantId,
    runId: approval.runId,
    sessionId,
    toolName: approval.toolName,
    reason: approval.reason,
    ...(approval.stepId ? { stepId: approval.stepId } : {}),
    createdAt: approval.createdAt,
    status: approval.status,
    ...(approval.decisionAt ? { decisionAt: approval.decisionAt } : {}),
  }));
}

function serializeApproval(approval: HeadlessApprovalRecord): Record<string, unknown> {
  return {
    approvalId: approval.approvalId,
    runId: approval.runId,
    toolName: approval.toolName,
    reason: approval.reason,
    stepId: approval.stepId,
    createdAt: approval.createdAt,
    status: approval.status,
  };
}
