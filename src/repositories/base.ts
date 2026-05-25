import type {
  ApiKeyRecord,
  HeadlessApprovalRecord,
  HeadlessEvent,
  HeadlessJob,
  HeadlessMessageRecord,
  HeadlessRunRecord,
  HeadlessSessionRecord,
  TenantRecord,
} from "../schemas.js";

export interface TenantRepository {
  create(record: TenantRecord): Promise<TenantRecord>;
  getById(tenantId: string): Promise<TenantRecord | undefined>;
}

export interface ApiKeyRepository {
  create(record: ApiKeyRecord): Promise<ApiKeyRecord>;
  authenticate(rawKey: string): Promise<ApiKeyRecord | undefined>;
  touchLastUsed(apiKeyId: string, timestamp: string): Promise<void>;
}

export interface SessionRepository {
  create(record: HeadlessSessionRecord): Promise<HeadlessSessionRecord>;
  getById(tenantId: string, sessionId: string): Promise<HeadlessSessionRecord | undefined>;
  update(record: HeadlessSessionRecord): Promise<HeadlessSessionRecord>;
}

export interface MessageRepository {
  create(record: HeadlessMessageRecord): Promise<HeadlessMessageRecord>;
  listBySession(tenantId: string, sessionId: string): Promise<HeadlessMessageRecord[]>;
}

export interface RunRepository {
  create(record: HeadlessRunRecord): Promise<HeadlessRunRecord>;
  getById(tenantId: string, runId: string): Promise<HeadlessRunRecord | undefined>;
  update(record: HeadlessRunRecord): Promise<HeadlessRunRecord>;
}

export interface ApprovalRepository {
  replaceForRun(runId: string, approvals: HeadlessApprovalRecord[]): Promise<void>;
  listByRun(tenantId: string, runId: string): Promise<HeadlessApprovalRecord[]>;
  getById(tenantId: string, approvalId: string): Promise<HeadlessApprovalRecord | undefined>;
  update(record: HeadlessApprovalRecord): Promise<HeadlessApprovalRecord>;
}

export interface EventRepository {
  append(event: HeadlessEvent): Promise<HeadlessEvent>;
  listByRun(tenantId: string, runId: string, afterEventId?: string): Promise<HeadlessEvent[]>;
  nextEventId(runId: string): Promise<string>;
}

export interface JobRepository {
  enqueue(job: HeadlessJob): Promise<HeadlessJob>;
  getByRun(runId: string): Promise<HeadlessJob | undefined>;
  leaseNext(workerId: string, now: Date, leaseDurationMs: number): Promise<HeadlessJob | undefined>;
  heartbeat(jobId: string, workerId: string, now: Date, leaseDurationMs: number): Promise<HeadlessJob | undefined>;
  complete(jobId: string, workerId: string, now: Date): Promise<void>;
  fail(jobId: string, workerId: string, now: Date, errorMessage: string): Promise<void>;
}

export interface RepositoryBundle {
  tenants: TenantRepository;
  apiKeys: ApiKeyRepository;
  sessions: SessionRepository;
  messages: MessageRepository;
  runs: RunRepository;
  approvals: ApprovalRepository;
  events: EventRepository;
  jobs: JobRepository;
}
