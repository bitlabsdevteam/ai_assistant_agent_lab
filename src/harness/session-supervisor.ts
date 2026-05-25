import { SessionStore } from "../memory/session-store.js";
import type { ArtifactStore } from "../memory/artifact-store.js";
import type { TerminalSessionState } from "../schemas.js";

export class SessionSupervisor {
  private readonly sessionStore: SessionStore;

  public constructor(private readonly artifactStore: ArtifactStore) {
    this.sessionStore = new SessionStore(artifactStore);
  }

  public async list(): Promise<TerminalSessionState[]> {
    return this.sessionStore.list();
  }

  public async inspect(sessionId: string): Promise<TerminalSessionState | undefined> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      return undefined;
    }
    const refreshed = this.refreshSession(session);
    await this.sessionStore.upsert(refreshed);
    return refreshed;
  }

  public async cancel(sessionId: string): Promise<TerminalSessionState | undefined> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      return undefined;
    }
    if (session.status !== "running") {
      return session;
    }

    const cancelled = this.terminateSession(session, "cancelled", "operator_cancelled");
    await this.sessionStore.upsert(cancelled);

    if (session.pid && isPidRunning(session.pid)) {
      try {
        process.kill(session.pid, "SIGTERM");
      } catch {
        const missing = this.terminateSession(session, "failed", "process_missing");
        await this.sessionStore.upsert(missing);
        return missing;
      }
    }
    return cancelled;
  }

  public async reconcileRunningSessions(
    reason: "recovery" | "manual" = "manual",
  ): Promise<TerminalSessionState[]> {
    const sessions = await this.sessionStore.list();
    const reconciled = sessions.map((session) => {
      if (session.status !== "running") {
        return session;
      }
      if (session.pid && isPidRunning(session.pid)) {
        return session;
      }
      return this.terminateSession(
        session,
        "failed",
        reason === "recovery" ? "stale_on_recovery" : "process_missing",
      );
    });
    await this.sessionStore.replaceAll(reconciled);
    return reconciled;
  }

  private refreshSession(session: TerminalSessionState): TerminalSessionState {
    if (session.status !== "running") {
      return session;
    }
    if (session.pid && isPidRunning(session.pid)) {
      return {
        ...session,
        lastActivityAt: new Date().toISOString(),
      };
    }
    return this.terminateSession(session, "failed", "process_missing");
  }

  private terminateSession(
    session: TerminalSessionState,
    status: TerminalSessionState["status"],
    terminationReason: NonNullable<TerminalSessionState["terminationReason"]>,
  ): TerminalSessionState {
    const timestamp = new Date().toISOString();
    return {
      ...session,
      lastActivityAt: timestamp,
      status,
      endedAt: timestamp,
      terminationReason,
    };
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    return code === "EPERM";
  }
}
