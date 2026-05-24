import type { ArtifactStore } from "../memory/artifact-store.js";
import {
  AgentContextSnapshotSchema,
  type AgentStepState,
  type AgentContextSnapshot,
  type AnalysisResult,
  type ApprovalRequest,
  type EvaluationResult,
  type ExecutionReport,
  type HarnessRunState,
  type RevisionRecord,
  type RunRequest,
} from "../schemas.js";

export interface ContextAssemblyInput {
  agent: "analyzer" | "executor" | "evaluator";
  request: RunRequest;
  state: HarnessRunState;
  analysis?: AnalysisResult;
  execution?: ExecutionReport;
  evaluation?: EvaluationResult;
  revisions?: RevisionRecord[];
  approvals?: ApprovalRequest[];
  stepTrace?: AgentStepState[];
  maxChars: number;
}

export class ContextManager {
  public constructor(private readonly artifactStore: ArtifactStore) {}

  public async assemble(input: ContextAssemblyInput): Promise<AgentContextSnapshot> {
    const sections: string[] = [];
    const sources: AgentContextSnapshot["sources"] = [];

    sections.push("Instruction hierarchy:");
    sections.push("1. System and developer instructions");
    sections.push("2. User task");
    sections.push("3. Current persisted run state");
    sections.push("4. Retrieved evidence and prior outputs");
    sources.push({ kind: "instruction", label: "Instruction hierarchy" });

    sections.push(`User task: ${input.request.task}`);
    sources.push({
      kind: "user_task",
      label: "Run request",
      artifact: this.artifactStore.resolve("request.json"),
    });

    sections.push(`Run state: status=${input.state.status}, phase=${input.state.phase}, iteration=${input.state.iteration}`);
    sources.push({
      kind: "run_state",
      label: "Harness run state",
      artifact: this.artifactStore.resolve("harness-state.json"),
    });

    if (input.analysis) {
      sections.push(
        `Analysis objective: ${input.analysis.objective}\nSuccess criteria: ${input.analysis.successCriteria.join("; ")}`,
      );
      sections.push(
        `Plan steps: ${input.analysis.plan.map((step) => `${step.id}:${step.title}[${step.toolNames.join(",")}]`).join(" | ")}`,
      );
      sources.push({
        kind: "analysis",
        label: "Analyzer result",
        artifact: this.artifactStore.resolve("analysis.json"),
      });
    }

    if (input.execution) {
      sections.push(
        `Execution summary: ${input.execution.summary}\nCompleted: ${input.execution.completedSteps.join(", ") || "none"}\nBlockers: ${
          input.execution.blockers.join("; ") || "none"
        }`,
      );
      const recentToolCalls = input.execution.toolCalls.slice(-5);
      if (recentToolCalls.length > 0) {
        sections.push(
          `Recent tool calls: ${recentToolCalls
            .map((call) => `${call.toolName}:${call.status}${call.error ? `(${call.error})` : ""}`)
            .join(" | ")}`,
        );
        sources.push({
          kind: "tool_output",
          label: "Execution tool calls",
          artifact: this.artifactStore.resolve("tool-calls.json"),
        });
      }
      sources.push({
        kind: "execution",
        label: "Execution report",
        artifact: this.artifactStore.resolve("execution.json"),
      });
    }

    if (input.evaluation) {
      sections.push(
        `Evaluation status: ${input.evaluation.status}\nRequired revisions: ${
          input.evaluation.requiredRevisions.join("; ") || "none"
        }`,
      );
      sources.push({
        kind: "evaluation",
        label: "Evaluation result",
        artifact: this.artifactStore.resolve("evaluation.json"),
      });
    }

    if ((input.revisions?.length ?? 0) > 0) {
      const recentRevisions = input.revisions!.slice(-5);
      sections.push(
        `Revision history: ${recentRevisions
          .map((revision) => `iter${revision.iteration}:${revision.evaluationStatus}:${revision.requiredRevisions.join(" / ") || "none"}`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "revision",
        label: "Revision history",
        artifact: this.artifactStore.resolve("revisions.json"),
      });
    }

    if ((input.approvals?.length ?? 0) > 0) {
      const recentApprovals = input.approvals!.slice(-5);
      sections.push(
        `Approvals: ${recentApprovals
          .map((approval) => `${approval.toolName}:${approval.status}${approval.stepId ? `@${approval.stepId}` : ""}`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "approval",
        label: "Approval decisions",
        artifact: this.artifactStore.resolve("approvals.json"),
      });
    }

    if ((input.stepTrace?.length ?? 0) > 0) {
      const recentSteps = input.stepTrace!.slice(-5);
      sections.push(
        `Recent step trace: ${recentSteps
          .map((step) => `${step.stepId}:${step.chosenActionName}:${step.resultSummary ?? "pending"}`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "step_trace",
        label: "Executor step trace",
        artifact: this.artifactStore.resolve("step-trace.jsonl"),
      });
    }

    const rawSummary = sections.join("\n\n");
    const compactedSummary = compact(rawSummary, input.maxChars);
    const snapshot = AgentContextSnapshotSchema.parse({
      agent: input.agent,
      summary: compactedSummary.text,
      promptChars: compactedSummary.text.length,
      compacted: compactedSummary.compacted,
      sources,
    });

    await this.persist(snapshot);
    return snapshot;
  }

  private async persist(snapshot: AgentContextSnapshot): Promise<void> {
    await this.artifactStore.writeText("context-summary.md", snapshot.summary);
    await this.artifactStore.writeJson("context-sources.json", snapshot.sources);
    await this.artifactStore.writeJson("context-snapshot.json", snapshot);
  }
}

function compact(value: string, maxChars: number): { text: string; compacted: boolean } {
  if (value.length <= maxChars) {
    return { text: value, compacted: false };
  }

  const headBudget = Math.floor(maxChars * 0.65);
  const tailBudget = Math.max(0, maxChars - headBudget - 32);
  const text = `${value.slice(0, headBudget)}\n\n[...compacted...]\n\n${value.slice(Math.max(0, value.length - tailBudget))}`;
  return {
    text,
    compacted: true,
  };
}
