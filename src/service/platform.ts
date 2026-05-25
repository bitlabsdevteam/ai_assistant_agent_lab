import type { Logger } from "pino";

import { ChatSessionManager } from "../chat/session-manager.js";
import { createLogger } from "../logger.js";
import { Orchestrator } from "../orchestrator.js";
import type { RepositoryBundle } from "../repositories/base.js";
import type { Settings } from "../schemas.js";
import { ApprovalService } from "./approval-service.js";
import { RunService } from "./run-service.js";
import { SessionService } from "./session-service.js";
import { StreamService } from "./stream-service.js";
import { HeadlessWorker } from "./worker.js";

export interface HeadlessPlatformOptions {
  logger?: Logger;
  createOrchestrator?: ConstructorParameters<typeof HeadlessWorker>[0]["createOrchestrator"];
  worker?: {
    autostart?: boolean;
    pollIntervalMs?: number;
    leaseDurationMs?: number;
  };
}

export class HeadlessPlatform {
  public readonly logger: Logger;
  public readonly streams: StreamService;
  public readonly chatSessions: ChatSessionManager;
  public readonly sessions: SessionService;
  public readonly runs: RunService;
  public readonly approvals: ApprovalService;
  public readonly worker: HeadlessWorker;

  public constructor(
    public readonly settings: Settings,
    public readonly repositories: RepositoryBundle,
    options: HeadlessPlatformOptions = {},
  ) {
    this.logger = options.logger ?? createLogger(settings);
    this.streams = new StreamService(repositories.events);
    this.chatSessions = new ChatSessionManager(settings.artifactDir);
    this.sessions = new SessionService(repositories.sessions, repositories.messages, this.chatSessions);
    this.runs = new RunService(
      repositories.sessions,
      repositories.messages,
      repositories.runs,
      repositories.jobs,
      this.chatSessions,
      this.streams,
      {
        streamBasePath: "/v1",
        maxIterations: settings.maxIterations,
      },
    );
    this.approvals = new ApprovalService(
      repositories.approvals,
      repositories.runs,
      repositories.sessions,
      repositories.jobs,
      this.streams,
      settings.artifactDir,
    );
    this.worker = new HeadlessWorker(
      {
        repositories,
        streams: this.streams,
        chatSessions: this.chatSessions,
        settings,
        logger: this.logger,
        createOrchestrator:
          options.createOrchestrator ??
          ((callbacks) =>
            new Orchestrator(settings, this.logger, {
              onEvent: callbacks.onEvent,
            })),
      },
      {
        ...(options.worker?.pollIntervalMs !== undefined ? { pollIntervalMs: options.worker.pollIntervalMs } : {}),
        ...(options.worker?.leaseDurationMs !== undefined ? { leaseDurationMs: options.worker.leaseDurationMs } : {}),
      },
    );
    if (options.worker?.autostart ?? true) {
      this.worker.start();
    }
  }

  public async authenticate(rawKey: string): Promise<{ tenantId: string } | undefined> {
    const apiKey = await this.repositories.apiKeys.authenticate(rawKey);
    if (!apiKey) {
      return undefined;
    }
    await this.repositories.apiKeys.touchLastUsed(apiKey.apiKeyId, new Date().toISOString());
    return {
      tenantId: apiKey.tenantId,
    };
  }
}
