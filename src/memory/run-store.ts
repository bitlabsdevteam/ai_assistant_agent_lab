import { mkdir, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ArtifactStore } from "./artifact-store.js";

export function createRunId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export class RunStore {
  public constructor(private readonly artifactDir: string) {}

  public async init(): Promise<void> {
    await mkdir(this.artifactDir, { recursive: true });
  }

  public createArtifactStore(runId: string): ArtifactStore {
    return new ArtifactStore(this.artifactDir, runId);
  }

  public async listRuns(): Promise<string[]> {
    await this.init();
    const entries = await readdir(this.artifactDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  }

  public resolveRunDirectory(runId: string): string {
    return path.join(this.artifactDir, runId);
  }
}
