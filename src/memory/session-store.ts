import type { ArtifactStore } from "./artifact-store.js";
import { TerminalSessionStateSchema, type TerminalSessionState } from "../schemas.js";

export class SessionStore {
  private readonly fileName = "sessions.json";

  public constructor(private readonly artifactStore: ArtifactStore) {}

  public async load(): Promise<TerminalSessionState[]> {
    try {
      const sessions = await this.artifactStore.readJson<TerminalSessionState[]>(this.fileName);
      return sessions.map((session) => TerminalSessionStateSchema.parse(session));
    } catch {
      return [];
    }
  }

  public async list(): Promise<TerminalSessionState[]> {
    return this.load();
  }

  public async get(sessionId: string): Promise<TerminalSessionState | undefined> {
    const sessions = await this.load();
    return sessions.find((session) => session.sessionId === sessionId);
  }

  public async upsert(session: TerminalSessionState): Promise<void> {
    const sessions = await this.load();
    const next = [...sessions];
    const index = next.findIndex((item) => item.sessionId === session.sessionId);
    if (index === -1) {
      next.push(session);
    } else {
      next[index] = session;
    }
    await this.artifactStore.writeJson(this.fileName, next);
  }

  public async replaceAll(sessions: TerminalSessionState[]): Promise<void> {
    await this.artifactStore.writeJson(this.fileName, sessions.map((session) => TerminalSessionStateSchema.parse(session)));
  }
}
