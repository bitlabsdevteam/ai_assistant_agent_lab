import type { ArtifactStore } from "../memory/artifact-store.js";
import { SessionSupervisor } from "./session-supervisor.js";
import {
  AnalysisResultSchema,
  ExecutionReportSchema,
  EvaluationResultSchema,
  HarnessRunStateSchema,
  RunBudgetStateSchema,
  RunRequestSchema,
  type TerminalSessionState,
  type AnalysisResult,
  type EvaluationResult,
  type ExecutionReport,
  type HarnessRunState,
  type RunBudgetState,
  type RunRequest,
} from "../schemas.js";

export interface RecoveredRun {
  state: HarnessRunState;
  request: RunRequest;
  analysis: AnalysisResult | undefined;
  execution: ExecutionReport | undefined;
  evaluation: EvaluationResult | undefined;
  budget: RunBudgetState;
  sessions: TerminalSessionState[];
}

export class RecoveryManager {
  public constructor(private readonly artifactStore: ArtifactStore) {}

  public async recoverState(): Promise<HarnessRunState> {
    const state = await this.artifactStore.readJson<HarnessRunState>("harness-state.json");
    return HarnessRunStateSchema.parse(state);
  }

  public async recoverRun(): Promise<RecoveredRun> {
    const state = await this.recoverState();
    const request = RunRequestSchema.parse(await this.artifactStore.readJson("request.json"));
    const analysis = await this.readOptional("analysis.json", AnalysisResultSchema);
    const execution = await this.readOptional("execution.json", ExecutionReportSchema);
    const evaluation = await this.readOptional("evaluation.json", EvaluationResultSchema);
    const budget = RunBudgetStateSchema.parse(await this.artifactStore.readJson("budget.json"));
    const sessions = await this.reconcileSessions();
    return {
      state,
      request,
      analysis,
      execution,
      evaluation,
      budget,
      sessions,
    };
  }

  public async reconcileSessions(): Promise<TerminalSessionState[]> {
    return new SessionSupervisor(this.artifactStore).reconcileRunningSessions("recovery");
  }

  private async readOptional<T>(
    fileName: string,
    schema: { parse(value: unknown): T },
  ): Promise<T | undefined> {
    try {
      return schema.parse(await this.artifactStore.readJson(fileName));
    } catch {
      return undefined;
    }
  }
}
