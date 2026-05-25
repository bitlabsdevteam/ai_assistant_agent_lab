import { createHash, randomUUID } from "node:crypto";

import {
  ApiKeyRecordSchema,
  HeadlessApprovalRecordSchema,
  HeadlessEventSchema,
  HeadlessJobSchema,
  HeadlessMessageRecordSchema,
  HeadlessRunRecordSchema,
  HeadlessSessionRecordSchema,
  TenantRecordSchema,
  type ApiKeyRecord,
  type HeadlessApprovalRecord,
  type HeadlessEvent,
  type HeadlessJob,
  type HeadlessMessageRecord,
  type HeadlessRunRecord,
  type HeadlessSessionRecord,
  type TenantRecord,
} from "../schemas.js";
import type { RepositoryBundle } from "./base.js";

export interface IssuedApiKey {
  apiKey: string;
  record: ApiKeyRecord;
}

export class InMemoryRepositoryBundle {
  private readonly tenantRecords = new Map<string, TenantRecord>();
  private readonly apiKeyRecords = new Map<string, ApiKeyRecord>();
  private readonly sessionRecords = new Map<string, HeadlessSessionRecord>();
  private readonly messagesBySession = new Map<string, HeadlessMessageRecord[]>();
  private readonly runRecords = new Map<string, HeadlessRunRecord>();
  private readonly approvalsByRun = new Map<string, HeadlessApprovalRecord[]>();
  private readonly eventsByRun = new Map<string, HeadlessEvent[]>();
  private readonly eventCounters = new Map<string, number>();
  private readonly jobRecords = new Map<string, HeadlessJob>();

  public readonly repositories: RepositoryBundle = {
    tenants: {
      create: async (record) => {
        const parsed = TenantRecordSchema.parse(record);
        this.tenantRecords.set(parsed.tenantId, parsed);
        return parsed;
      },
      getById: async (tenantId) => this.tenantRecords.get(tenantId),
    },
    apiKeys: {
      create: async (record) => {
        const parsed = ApiKeyRecordSchema.parse(record);
        this.apiKeyRecords.set(parsed.apiKeyId, parsed);
        return parsed;
      },
      authenticate: async (rawKey) => {
        const hash = hashApiKey(rawKey);
        for (const record of this.apiKeyRecords.values()) {
          if (record.keyHash === hash) {
            return record;
          }
        }
        return undefined;
      },
      touchLastUsed: async (apiKeyId, timestamp) => {
        const existing = this.apiKeyRecords.get(apiKeyId);
        if (!existing) {
          return;
        }
        this.apiKeyRecords.set(apiKeyId, {
          ...existing,
          lastUsedAt: timestamp,
        });
      },
    },
    sessions: {
      create: async (record) => {
        const parsed = HeadlessSessionRecordSchema.parse(record);
        this.sessionRecords.set(parsed.sessionId, parsed);
        return parsed;
      },
      getById: async (tenantId, sessionId) => {
        const existing = this.sessionRecords.get(sessionId);
        return existing?.tenantId === tenantId ? existing : undefined;
      },
      update: async (record) => {
        const parsed = HeadlessSessionRecordSchema.parse(record);
        this.sessionRecords.set(parsed.sessionId, parsed);
        return parsed;
      },
    },
    messages: {
      create: async (record) => {
        const parsed = HeadlessMessageRecordSchema.parse(record);
        const existing = this.messagesBySession.get(parsed.sessionId) ?? [];
        this.messagesBySession.set(parsed.sessionId, [...existing, parsed]);
        return parsed;
      },
      listBySession: async (tenantId, sessionId) =>
        (this.messagesBySession.get(sessionId) ?? [])
          .filter((message) => message.tenantId === tenantId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    },
    runs: {
      create: async (record) => {
        const parsed = HeadlessRunRecordSchema.parse(record);
        this.runRecords.set(parsed.runId, parsed);
        return parsed;
      },
      getById: async (tenantId, runId) => {
        const existing = this.runRecords.get(runId);
        return existing?.tenantId === tenantId ? existing : undefined;
      },
      update: async (record) => {
        const parsed = HeadlessRunRecordSchema.parse(record);
        this.runRecords.set(parsed.runId, parsed);
        return parsed;
      },
    },
    approvals: {
      replaceForRun: async (runId, approvals) => {
        this.approvalsByRun.set(
          runId,
          approvals.map((approval) => HeadlessApprovalRecordSchema.parse(approval)),
        );
      },
      listByRun: async (tenantId, runId) =>
        (this.approvalsByRun.get(runId) ?? [])
          .filter((approval) => approval.tenantId === tenantId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      getById: async (tenantId, approvalId) => {
        for (const approvals of this.approvalsByRun.values()) {
          const match = approvals.find((approval) => approval.approvalId === approvalId && approval.tenantId === tenantId);
          if (match) {
            return match;
          }
        }
        return undefined;
      },
      update: async (record) => {
        const parsed = HeadlessApprovalRecordSchema.parse(record);
        const approvals = this.approvalsByRun.get(parsed.runId) ?? [];
        const next = approvals.filter((approval) => approval.approvalId !== parsed.approvalId);
        next.push(parsed);
        this.approvalsByRun.set(parsed.runId, next);
        return parsed;
      },
    },
    events: {
      append: async (event) => {
        const parsed = HeadlessEventSchema.parse(event);
        const existing = this.eventsByRun.get(parsed.runId) ?? [];
        this.eventsByRun.set(parsed.runId, [...existing, parsed]);
        return parsed;
      },
      listByRun: async (tenantId, runId, afterEventId) => {
        const events = (this.eventsByRun.get(runId) ?? [])
          .filter((event) => event.tenantId === tenantId)
          .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.eventId.localeCompare(right.eventId));
        if (!afterEventId) {
          return events;
        }
        const index = events.findIndex((event) => event.eventId === afterEventId);
        return index === -1 ? events : events.slice(index + 1);
      },
      nextEventId: async (runId) => {
        const next = (this.eventCounters.get(runId) ?? 0) + 1;
        this.eventCounters.set(runId, next);
        return `${runId}-${String(next).padStart(6, "0")}`;
      },
    },
    jobs: {
      enqueue: async (job) => {
        const parsed = HeadlessJobSchema.parse(job);
        this.jobRecords.set(parsed.jobId, parsed);
        return parsed;
      },
      getByRun: async (runId) => {
        for (const job of this.jobRecords.values()) {
          if (job.runId === runId && (job.status === "queued" || job.status === "leased")) {
            return job;
          }
        }
        return undefined;
      },
      leaseNext: async (workerId, now, leaseDurationMs) => {
        const candidates = [...this.jobRecords.values()]
          .filter(
            (job) =>
              job.status === "queued" ||
              (job.status === "leased" &&
                job.leaseExpiresAt !== undefined &&
                new Date(job.leaseExpiresAt).getTime() <= now.getTime()),
          )
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        const next = candidates[0];
        if (!next) {
          return undefined;
        }
        const leased = HeadlessJobSchema.parse({
          ...next,
          status: "leased",
          attempts: next.attempts + 1,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
          lastHeartbeatAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        this.jobRecords.set(leased.jobId, leased);
        return leased;
      },
      heartbeat: async (jobId, workerId, now, leaseDurationMs) => {
        const existing = this.jobRecords.get(jobId);
        if (!existing || existing.leaseOwner !== workerId || existing.status !== "leased") {
          return undefined;
        }
        const updated = HeadlessJobSchema.parse({
          ...existing,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
          lastHeartbeatAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        this.jobRecords.set(jobId, updated);
        return updated;
      },
      complete: async (jobId, workerId, now) => {
        const existing = this.jobRecords.get(jobId);
        if (!existing || existing.leaseOwner !== workerId) {
          return;
        }
        this.jobRecords.set(
          jobId,
          HeadlessJobSchema.parse({
            ...existing,
            status: "completed",
            updatedAt: now.toISOString(),
          }),
        );
      },
      fail: async (jobId, workerId, now, errorMessage) => {
        const existing = this.jobRecords.get(jobId);
        if (!existing || existing.leaseOwner !== workerId) {
          return;
        }
        this.jobRecords.set(
          jobId,
          HeadlessJobSchema.parse({
            ...existing,
            status: "failed",
            updatedAt: now.toISOString(),
            errorMessage,
          }),
        );
      },
    },
  };

  public async createTenant(name: string, metadata: Record<string, unknown> = {}): Promise<TenantRecord> {
    const tenant = TenantRecordSchema.parse({
      tenantId: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      metadata,
    });
    return this.repositories.tenants.create(tenant);
  }

  public async issueApiKey(tenantId: string, label = "default"): Promise<IssuedApiKey> {
    const rawKey = `lh_${randomUUID().replaceAll("-", "")}`;
    const record = ApiKeyRecordSchema.parse({
      apiKeyId: randomUUID(),
      tenantId,
      label,
      keyHash: hashApiKey(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      createdAt: new Date().toISOString(),
    });
    await this.repositories.apiKeys.create(record);
    return {
      apiKey: rawKey,
      record,
    };
  }
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
