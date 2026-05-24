import { randomUUID } from "node:crypto";

import { CheckpointRecordSchema, type CheckpointRecord, type HarnessRunState } from "../schemas.js";
import type { ArtifactStore } from "../memory/artifact-store.js";

export class CheckpointManager {
  public constructor(private readonly artifactStore: ArtifactStore) {}

  public async writeCheckpoint(state: HarnessRunState): Promise<CheckpointRecord> {
    const checkpoint = CheckpointRecordSchema.parse({
      checkpointId: randomUUID(),
      runId: state.runId,
      createdAt: new Date().toISOString(),
      status: state.status,
      phase: state.phase,
      iteration: state.iteration,
      latestAnalysisArtifact: state.analysisArtifact,
      latestExecutionArtifact: state.executionArtifact,
      latestEvaluationArtifact: state.evaluationArtifact,
      budgetArtifact: this.artifactStore.resolve("budget.json"),
      sessionsArtifact: this.artifactStore.resolve("sessions.json"),
      approvalsArtifact: this.artifactStore.resolve("approvals.json"),
    });
    await this.artifactStore.writeJson(`checkpoints/${checkpoint.checkpointId}.json`, checkpoint);
    return checkpoint;
  }
}
