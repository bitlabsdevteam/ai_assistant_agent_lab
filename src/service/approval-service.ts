import { ApprovalManager } from "../harness/approvals.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import {
  HeadlessApprovalDecisionInputSchema,
  type HeadlessApprovalRecord,
} from "../schemas.js";
import type { ApprovalRepository, JobRepository, RunRepository, SessionRepository } from "../repositories/base.js";
import { StreamService } from "./stream-service.js";
import { approvalStateFromApprovals, createPublicId } from "./utils.js";

export class ApprovalService {
  public constructor(
    private readonly approvals: ApprovalRepository,
    private readonly runs: RunRepository,
    private readonly sessions: SessionRepository,
    private readonly jobs: JobRepository,
    private readonly streams: StreamService,
    private readonly artifactDir: string,
    private readonly options: {
      now?: () => Date;
    } = {},
  ) {}

  public async list(tenantId: string, runId: string): Promise<HeadlessApprovalRecord[]> {
    return this.approvals.listByRun(tenantId, runId);
  }

  public async decide(
    tenantId: string,
    approvalId: string,
    input: unknown,
  ): Promise<HeadlessApprovalRecord | undefined> {
    const parsed = HeadlessApprovalDecisionInputSchema.parse(input);
    const approval = await this.approvals.getById(tenantId, approvalId);
    if (!approval) {
      return undefined;
    }
    const decisionAt = this.timestamp();
    const updated = await this.approvals.update({
      ...approval,
      status: parsed.decision,
      decisionAt,
    });

    const artifactApprovalManager = new ApprovalManager(new ArtifactStore(this.artifactDir, approval.runId));
    await artifactApprovalManager.load();
    await artifactApprovalManager.decide(approval.approvalId, parsed.decision);

    const run = await this.runs.getById(tenantId, approval.runId);
    const session = await this.sessions.getById(tenantId, approval.sessionId);
    if (!run || !session) {
      return updated;
    }

    const approvals = await this.approvals.listByRun(tenantId, approval.runId);
    const approvalState = approvalStateFromApprovals(approvals);
    await this.runs.update({
      ...run,
      approvalState,
      status: parsed.decision === "denied" ? "blocked" : run.status,
      updatedAt: decisionAt,
      ...(parsed.decision === "denied" ? { errorMessage: "Approval denied." } : {}),
    });
    await this.sessions.update({
      ...session,
      pendingApprovalsCount: approvals.filter((item) => item.status === "pending").length,
      status: parsed.decision === "denied" ? "blocked" : session.status,
      updatedAt: decisionAt,
    });

    await this.streams.publish({
      tenantId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      type: "approval.resolved",
      data: {
        approvalId: approval.approvalId,
        decision: parsed.decision,
      },
    });
    if (parsed.decision === "denied") {
      await this.streams.publish({
        tenantId,
        sessionId: approval.sessionId,
        runId: approval.runId,
        type: "run.status_changed",
        data: {
          status: "blocked",
        },
      });
    }

    if (parsed.decision === "approved" && approvals.every((item) => item.status !== "pending")) {
      await this.jobs.enqueue({
        jobId: createPublicId(),
        tenantId,
        runId: approval.runId,
        sessionId: approval.sessionId,
        kind: "resume",
        status: "queued",
        attempts: 0,
        createdAt: decisionAt,
        updatedAt: decisionAt,
      });
    }

    return updated;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
