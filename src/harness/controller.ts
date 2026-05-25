import { createHash } from "node:crypto";

import type { Logger } from "pino";

import { AnalyzerAgent } from "../agents/analyzer.js";
import type { AgentRuntimeContext } from "../agents/base.js";
import { EvaluatorAgent } from "../agents/evaluator.js";
import { ExecutorAgent } from "../agents/executor.js";
import { ContextManager } from "../context/manager.js";
import { AppError } from "../errors.js";
import type { ArtifactStore } from "../memory/artifact-store.js";
import { createEvent } from "../telemetry/events.js";
import { ApprovalManager } from "./approvals.js";
import { BudgetManager } from "./budget-manager.js";
import { CheckpointManager } from "./checkpoint-manager.js";
import { Finalizer } from "./finalizer.js";
import { LeaseManager } from "./lease-manager.js";
import { RecoveryManager } from "./recovery.js";
import { Scheduler } from "./scheduler.js";
import { transitionRunState } from "./state-machine.js";
import type { LLMClient, LLMStreamEvent } from "../llm/client.js";
import { TokenUsageTracker } from "../llm/usage-tracker.js";
import type { RunStore } from "../memory/run-store.js";
import type { PermissionPolicy } from "../policy/permissions.js";
import type { MetricsCollector } from "../telemetry/metrics.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  HarnessRunStateSchema,
  RunBudgetStateSchema,
  type AnalysisResult,
  type EvaluationResult,
  type ExecutionReport,
  type HarnessRunState,
  type RunRequest,
  type TelemetryEvent,
} from "../schemas.js";

export interface HarnessDependencies {
  runStore: RunStore;
  artifactStore: ArtifactStore;
  llm: LLMClient;
  tools: ToolRegistry;
  policy: PermissionPolicy;
  logger: Logger;
  metrics: MetricsCollector;
  onEvent?: (event: TelemetryEvent) => void | Promise<void>;
  onLLMEvent?: (event: LLMStreamEvent) => void | Promise<void>;
}

export interface RunResult {
  state: HarnessRunState;
  request: RunRequest;
  analysis: AnalysisResult | undefined;
  execution: ExecutionReport | undefined;
  evaluation: EvaluationResult | undefined;
}

export class HarnessController {
  private readonly analyzer = new AnalyzerAgent();
  private readonly executor = new ExecutorAgent();
  private readonly evaluator = new EvaluatorAgent();
  private readonly approvals: ApprovalManager;
  private readonly checkpoints: CheckpointManager;
  private readonly scheduler = new Scheduler();
  private readonly leaseManager = new LeaseManager();
  private readonly recovery: RecoveryManager;
  private readonly budgetManager = new BudgetManager();
  private readonly finalizer: Finalizer;

  public constructor(private readonly dependencies: HarnessDependencies) {
    this.approvals = new ApprovalManager(dependencies.artifactStore);
    this.checkpoints = new CheckpointManager(dependencies.artifactStore);
    this.recovery = new RecoveryManager(dependencies.artifactStore);
    this.finalizer = new Finalizer(dependencies.artifactStore);
  }

  public async run(request: RunRequest): Promise<RunResult> {
    await this.dependencies.artifactStore.init();
    await this.approvals.load();
    await this.dependencies.artifactStore.writeJson("selected-skills.json", request.selectedSkills);

    let state = HarnessRunStateSchema.parse({
      runId: this.dependencies.artifactStore.runId,
      status: "created",
      phase: "created",
      iteration: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactDirectory: this.dependencies.artifactStore.runDirectory,
      requestArtifact: await this.dependencies.artifactStore.writeJson("request.json", request),
    });

    state = this.leaseManager.acquire(state);
    const budget = RunBudgetStateSchema.parse({
      maxIterations: request.maxIterations,
      maxToolCalls: request.maxIterations * 8,
      maxPromptChars: 100_000,
    });
    state = await this.persistWithCheckpoint(state, budget);
    await this.writeEvent(state.runId, "harness.run_started", "success");

    let analysis: AnalysisResult | undefined;
    let execution: ExecutionReport | undefined;
    let evaluation: EvaluationResult | undefined;
    const stepTrace: AgentRuntimeContext["stepTrace"] = [];

    for (let iteration = 0; iteration < request.maxIterations; iteration += 1) {
      state = {
        ...state,
        iteration,
      };
      state = transitionRunState(state, iteration === 0 ? "planning" : "revising", "analysis");
      state = await this.persistWithCheckpoint(state, budget);

      let runtime = this.createAgentContext(request, budget, stepTrace);
      runtime = await this.attachContextSnapshot(
        runtime,
        "analyzer",
        state,
        request,
        buildContextEvidence({ analysis, execution, evaluation }),
      );
      await this.writeAgentEvent(state.runId, "started", this.analyzer.name, {
        phase: state.phase,
        iteration,
      });
      analysis = await this.analyzer.run(request, runtime);
      state = {
        ...state,
        analysisArtifact: await this.dependencies.artifactStore.writeJson("analysis.json", analysis),
      };
      await this.writeAgentEvent(state.runId, "completed", this.analyzer.name, {
        phase: state.phase,
        iteration,
      });
      state = await this.persistWithCheckpoint(state, budget);

      state = transitionRunState(state, "executing", "execution");
      state = await this.persistWithCheckpoint(state, budget);
      runtime = await this.attachContextSnapshot(
        runtime,
        "executor",
        state,
        request,
        buildContextEvidence({ analysis, execution, evaluation }),
      );
      await this.writeAgentEvent(state.runId, "started", this.executor.name, {
        phase: state.phase,
        iteration,
      });
      execution = await this.executor.run({ analysis }, runtime);
      state = {
        ...state,
        executionArtifact: await this.dependencies.artifactStore.writeJson("execution.json", execution),
      };
      await this.dependencies.artifactStore.writeJson("tool-calls.json", execution.toolCalls);
      await this.dependencies.artifactStore.writeJson("step-trace.jsonl", stepTrace);
      await this.writeAgentEvent(state.runId, "completed", this.executor.name, {
        phase: state.phase,
        iteration,
      });
      state = await this.persistWithCheckpoint(state, budget);

      const pendingApproval = this.approvals.pending().length > 0;
      if (pendingApproval) {
        state = transitionRunState(state, "awaiting_approval", "approval");
        state = await this.persistWithCheckpoint(state, budget);
        await this.writeEvent(state.runId, "harness.awaiting_approval", "pending");
        break;
      }

      state = transitionRunState(state, "evaluating", "evaluation");
      state = await this.persistWithCheckpoint(state, budget);
      runtime = await this.attachContextSnapshot(
        runtime,
        "evaluator",
        state,
        request,
        buildContextEvidence({ analysis, execution, evaluation }),
      );
      await this.writeAgentEvent(state.runId, "started", this.evaluator.name, {
        phase: state.phase,
        iteration,
      });
      evaluation = await this.evaluator.run({ analysis, execution }, runtime);
      state = {
        ...state,
        evaluationArtifact: await this.dependencies.artifactStore.writeJson("evaluation.json", evaluation),
      };
      await this.writeAgentEvent(state.runId, "completed", this.evaluator.name, {
        phase: state.phase,
        iteration,
      });
      await this.writeEvent(
        state.runId,
        evaluation.status === "pass" ? "evaluation.passed" : "evaluation.failed",
        evaluation.status,
      );
      state = await this.persistWithCheckpoint(state, budget);

      const nextStatus = this.scheduler.nextStatusFromEvaluation(evaluation);
      if (nextStatus === "completed") {
        state = transitionRunState(state, "completed", "finalized");
        state = {
          ...state,
          finalReportArtifact: await this.finalizer.writeFinalReport({
            request,
            state,
            analysis,
            execution,
            evaluation,
          }),
        };
        state = await this.persistWithCheckpoint(state, budget);
        await this.writeEvent(state.runId, "run.completed", "success");
        return { state, request, analysis, execution, evaluation };
      }
      if (nextStatus === "failed") {
        state = transitionRunState(state, "failed", "evaluation");
        state = {
          ...state,
          finalReportArtifact: await this.finalizer.writeFinalReport({
            request,
            state,
            analysis,
            execution,
            evaluation,
          }),
        };
        state = await this.persistWithCheckpoint(state, budget);
        await this.writeEvent(state.runId, "run.failed", "failed");
        return { state, request, analysis, execution, evaluation };
      }
    }

    if (state.status !== "awaiting_approval") {
      state = transitionRunState(state, "failed", "max-iterations");
      state = {
        ...state,
        finalReportArtifact: await this.finalizer.writeFinalReport({
          request,
          state,
          analysis,
          execution,
          evaluation,
        }),
      };
      state = await this.persistWithCheckpoint(state, budget);
      await this.writeEvent(state.runId, "run.failed", "failed");
    }

    return { state, request, analysis, execution, evaluation };
  }

  public async recover(): Promise<HarnessRunState> {
    return this.recovery.recoverState();
  }

  public async resume(): Promise<RunResult> {
    await this.dependencies.artifactStore.init();
    const recovered = await this.recovery.recoverRun();
    await this.approvals.load();
    if (recovered.sessions.some((session) => session.status === "failed")) {
      await this.writeEvent(recovered.state.runId, "harness.recovered", "success", {
        reconciledSessions: recovered.sessions.filter((session) => session.status === "failed").length,
      });
    }

    if (recovered.state.status !== "awaiting_approval" && recovered.state.status !== "paused") {
      return {
        state: recovered.state,
        request: recovered.request,
        analysis: recovered.analysis,
        execution: recovered.execution,
        evaluation: recovered.evaluation,
      };
    }

    if (!recovered.analysis) {
      throw new AppError("VALIDATION_ERROR", "Cannot resume run without stored analysis.");
    }
    if (this.approvals.pending().length > 0) {
      return {
        state: recovered.state,
        request: recovered.request,
        analysis: recovered.analysis,
        execution: recovered.execution,
        evaluation: recovered.evaluation,
      };
    }

    let state = transitionRunState(recovered.state, "executing", "resume-execution");
    state = this.leaseManager.renew(state);
    state = await this.persistWithCheckpoint(state, recovered.budget);
    await this.writeEvent(state.runId, "harness.resumed", "success");

    const stepTrace = await this.readStepTrace();
    let runtime = this.createAgentContext(recovered.request, recovered.budget, stepTrace);
    runtime = await this.attachContextSnapshot(
      runtime,
      "executor",
      state,
      recovered.request,
      buildContextEvidence({
        analysis: recovered.analysis,
        execution: recovered.execution,
        evaluation: recovered.evaluation,
      }),
    );
    await this.writeAgentEvent(state.runId, "started", this.executor.name, {
      phase: state.phase,
      iteration: state.iteration,
      resume: true,
    });
    const execution = await this.executor.run(
      {
        analysis: recovered.analysis,
        ...(recovered.execution ? { priorExecution: recovered.execution } : {}),
      },
      runtime,
    );
    state = {
      ...state,
      executionArtifact: await this.dependencies.artifactStore.writeJson("execution.json", execution),
    };
    await this.dependencies.artifactStore.writeJson("tool-calls.json", execution.toolCalls);
    await this.dependencies.artifactStore.writeJson("step-trace.jsonl", stepTrace);
    await this.writeAgentEvent(state.runId, "completed", this.executor.name, {
      phase: state.phase,
      iteration: state.iteration,
      resume: true,
    });
    state = await this.persistWithCheckpoint(state, recovered.budget);

    if (this.approvals.pending().length > 0) {
      state = transitionRunState(state, "awaiting_approval", "approval");
      state = await this.persistWithCheckpoint(state, recovered.budget);
      await this.writeEvent(state.runId, "harness.awaiting_approval", "pending");
      return {
        state,
        request: recovered.request,
        analysis: recovered.analysis,
        execution,
        evaluation: recovered.evaluation,
      };
    }

    state = transitionRunState(state, "evaluating", "resume-evaluation");
    state = await this.persistWithCheckpoint(state, recovered.budget);
    runtime = await this.attachContextSnapshot(
      runtime,
      "evaluator",
      state,
      recovered.request,
      buildContextEvidence({
        analysis: recovered.analysis,
        execution,
        evaluation: recovered.evaluation,
      }),
    );
    await this.writeAgentEvent(state.runId, "started", this.evaluator.name, {
      phase: state.phase,
      iteration: state.iteration,
      resume: true,
    });
    const evaluation = await this.evaluator.run({ analysis: recovered.analysis, execution }, runtime);
    state = {
      ...state,
      evaluationArtifact: await this.dependencies.artifactStore.writeJson("evaluation.json", evaluation),
    };
    await this.writeAgentEvent(state.runId, "completed", this.evaluator.name, {
      phase: state.phase,
      iteration: state.iteration,
      resume: true,
    });
    state = await this.persistWithCheckpoint(state, recovered.budget);

    const nextStatus = this.scheduler.nextStatusFromEvaluation(evaluation);
    if (nextStatus === "completed") {
      state = transitionRunState(state, "completed", "finalized");
      state = {
        ...state,
        finalReportArtifact: await this.finalizer.writeFinalReport({
          request: recovered.request,
          state,
          analysis: recovered.analysis,
          execution,
          evaluation,
        }),
      };
      state = await this.persistWithCheckpoint(state, recovered.budget);
      await this.writeEvent(state.runId, "run.completed", "success");
    } else if (nextStatus === "failed") {
      state = transitionRunState(state, "failed", "evaluation");
      state = {
        ...state,
        finalReportArtifact: await this.finalizer.writeFinalReport({
          request: recovered.request,
          state,
          analysis: recovered.analysis,
          execution,
          evaluation,
        }),
      };
      state = await this.persistWithCheckpoint(state, recovered.budget);
      await this.writeEvent(state.runId, "run.failed", "failed");
    } else {
      state = transitionRunState(state, "revising", "resume-revision");
      state = await this.persistWithCheckpoint(state, recovered.budget);
    }

    return {
      state,
      request: recovered.request,
      analysis: recovered.analysis,
      execution,
      evaluation,
    };
  }

  private createAgentContext(
    request: RunRequest,
    budget: AgentRuntimeContext["budget"],
    stepTrace: AgentRuntimeContext["stepTrace"],
  ): AgentRuntimeContext {
    const usageTracker = new TokenUsageTracker(
      this.dependencies.artifactStore,
      this.dependencies.artifactStore.runId,
      budget,
      this.dependencies.onEvent,
    );
    return {
      runId: this.dependencies.artifactStore.runId,
      workingDirectory: request.workingDirectory,
      settings: this.dependencies.policy.settings,
      permissions: ["read-only", "workspace", "shell"],
      dryRun: request.dryRun,
      llm: this.dependencies.llm,
      tools: this.dependencies.tools,
      policy: this.dependencies.policy,
      approvalManager: this.approvals,
      approvals: this.approvals.snapshot(),
      operatorMode: request.metadata.sessionMode ?? "full-auto",
      artifactStore: this.dependencies.artifactStore,
      logger: this.dependencies.logger,
      budget,
      usageTracker,
      stepTrace,
      runRequest: request,
      ...(this.dependencies.onLLMEvent ? { onLLMEvent: this.dependencies.onLLMEvent } : {}),
      ...(this.dependencies.onEvent ? { onTelemetryEvent: this.dependencies.onEvent } : {}),
      signal: AbortSignal.timeout(30_000),
    };
  }

  private async persistWithCheckpoint(
    state: HarnessRunState,
    budget: AgentRuntimeContext["budget"],
  ): Promise<HarnessRunState> {
    this.budgetManager.ensureWithinLimits(budget);
    const checkpoint = await this.checkpoints.writeCheckpoint(state);
    const nextState = {
      ...state,
      checkpointId: checkpoint.checkpointId,
      updatedAt: new Date().toISOString(),
    };
    await this.persistState(nextState);
    await this.dependencies.artifactStore.writeJson("budget.json", budget);
    await this.writeEvent(state.runId, "harness.checkpoint_written", "success", {
      checkpointId: checkpoint.checkpointId,
    });
    return nextState;
  }

  private async persistState(state: HarnessRunState): Promise<void> {
    const hashed = createHash("sha1").update(JSON.stringify(state)).digest("hex");
    const enriched = {
      ...state,
      stateHash: hashed,
    };
    await this.dependencies.artifactStore.writeJson("harness-state.json", enriched);
  }

  private async writeEvent(
    runId: string,
    event: string,
    status: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this.dependencies.metrics.addMetric("run.event", 1, runId);
    const telemetryEvent = createEvent({
      runId,
      event,
      status,
      ...(details ? { details } : {}),
    });
    await this.dependencies.artifactStore.appendJsonl(
      "events.jsonl",
      telemetryEvent,
    );
    await this.dependencies.onEvent?.(telemetryEvent);
  }

  private async writeAgentEvent(
    runId: string,
    lifecycle: "started" | "completed",
    agent: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.writeEvent(runId, `agent.${lifecycle}`, lifecycle === "completed" ? "success" : "running", {
      agent,
      ...(details ? details : {}),
    });
  }

  private async readStepTrace(): Promise<AgentRuntimeContext["stepTrace"]> {
    try {
      return await this.dependencies.artifactStore.readJson<AgentRuntimeContext["stepTrace"]>("step-trace.jsonl");
    } catch {
      return [];
    }
  }

  private async attachContextSnapshot(
    runtime: AgentRuntimeContext,
    agent: "analyzer" | "executor" | "evaluator",
    state: HarnessRunState,
    request: RunRequest,
    evidence: {
      analysis: AnalysisResult | undefined;
      execution: ExecutionReport | undefined;
      evaluation: EvaluationResult | undefined;
    },
  ): Promise<AgentRuntimeContext> {
    const contextManager = new ContextManager(this.dependencies.artifactStore);
    const snapshot = await contextManager.assemble({
      agent,
      request,
      state,
      ...(evidence.analysis ? { analysis: evidence.analysis } : {}),
      ...(evidence.execution ? { execution: evidence.execution } : {}),
      ...(evidence.evaluation ? { evaluation: evidence.evaluation } : {}),
      approvals: this.approvals.snapshot(),
      stepTrace: runtime.stepTrace,
    });
    return {
      ...runtime,
      contextSnapshot: snapshot,
    };
  }
}

function buildContextEvidence(input: {
  analysis: AnalysisResult | undefined;
  execution: ExecutionReport | undefined;
  evaluation: EvaluationResult | undefined;
}): {
  analysis: AnalysisResult | undefined;
  execution: ExecutionReport | undefined;
  evaluation: EvaluationResult | undefined;
} {
  return {
    analysis: input.analysis,
    execution: input.execution,
    evaluation: input.evaluation,
  };
}
