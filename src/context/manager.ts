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

    sections.push("[trusted] Instruction hierarchy:");
    sections.push("1. System and developer instructions");
    sections.push("2. User task");
    sections.push("3. Current persisted run state");
    sections.push("4. Retrieved evidence and prior outputs");
    sources.push({ kind: "instruction", label: "Instruction hierarchy", trustLevel: "trusted" });

    sections.push(`[trusted] User task: ${input.request.task}`);
    sources.push({
      kind: "user_task",
      label: "Run request",
      artifact: this.artifactStore.resolve("request.json"),
      trustLevel: "trusted",
    });

    if (input.request.conversationContext) {
      const chat = input.request.conversationContext;
      sections.push(
        [
          "[trusted] Chat context:",
          `Chat session: ${chat.sessionId}`,
          `Latest user message: ${chat.latestUserMessage}`,
          `Conversation summary: ${chat.conversationSummary || "none"}`,
          `Last assistant summary: ${chat.lastAssistantSummary ?? "none"}`,
          `Recent turns: ${
            chat.recentTurns.length > 0
              ? chat.recentTurns.map((turn) => `${turn.role}:${turn.summary ?? turn.content}`).join(" | ")
              : "none"
          }`,
        ].join("\n"),
      );
      sources.push({
        kind: "chat_session",
        label: "Chat session summary",
        artifact: this.artifactStore.resolve("request.json"),
        trustLevel: "trusted",
      });
      for (const artifact of chat.includedArtifactRefs) {
        sources.push({
          kind: "chat_session",
          label: "Referenced chat artifact",
          artifact,
          trustLevel: "untrusted_context",
        });
      }
    }

    if (input.request.selectedSkills.length > 0) {
      sections.push(
        `[trusted] Selected skills: ${input.request.selectedSkills
          .map((skill) => `${skill.name}[${skill.scope}]: ${skill.reasons.map((reason) => reason.detail).join("; ")}`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "skill",
        label: "Selected skills",
        artifact: this.artifactStore.resolve("selected-skills.json"),
        trustLevel: "trusted",
      });
    }

    sections.push(
      `[trusted] Run state: status=${input.state.status}, phase=${input.state.phase}, iteration=${input.state.iteration}`,
    );
    sources.push({
      kind: "run_state",
      label: "Harness run state",
      artifact: this.artifactStore.resolve("harness-state.json"),
      trustLevel: "trusted",
    });

    if (input.analysis) {
      sections.push(
        `[untrusted_context] Analysis objective: ${input.analysis.objective}\nSuccess criteria: ${input.analysis.successCriteria.join("; ")}`,
      );
      sections.push(
        `[untrusted_context] Plan steps: ${input.analysis.plan
          .map((step) => `${step.id}:${step.title}[${step.toolNames.join(",")}]`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "analysis",
        label: "Analyzer result",
        artifact: this.artifactStore.resolve("analysis.json"),
        trustLevel: "untrusted_context",
      });
    }

    if (input.execution) {
      const recentDiffs = input.execution.toolCalls
        .map((call) => call.diffArtifact)
        .filter((artifact): artifact is string => typeof artifact === "string")
        .slice(-5);
      sections.push(
        `[untrusted_context] Execution summary: ${input.execution.summary}\nCompleted: ${
          input.execution.completedSteps.join(", ") || "none"
        }\nBlockers: ${input.execution.blockers.join("; ") || "none"}`,
      );
      const recentToolCalls = input.execution.toolCalls.slice(-5);
      if (recentToolCalls.length > 0) {
        sections.push(
          `[untrusted_context] Recent tool calls: ${recentToolCalls
            .map((call) => `${call.toolName}:${call.status}${call.error ? `(${call.error})` : ""}`)
            .join(" | ")}`,
        );
        sources.push({
          kind: "tool_output",
          label: "Execution tool calls",
          artifact: this.artifactStore.resolve("tool-calls.json"),
          trustLevel: "untrusted_context",
        });
      }
      sources.push({
        kind: "execution",
        label: "Execution report",
        artifact: this.artifactStore.resolve("execution.json"),
        trustLevel: "untrusted_context",
      });
      if (recentDiffs.length > 0) {
        sections.push(`[untrusted_context] Current diff state: ${recentDiffs.join(" | ")}`);
      }
    }

    if (input.evaluation) {
      sections.push(
        `[untrusted_context] Evaluation status: ${input.evaluation.status}\nRequired revisions: ${
          input.evaluation.requiredRevisions.join("; ") || "none"
        }`,
      );
      if (input.evaluation.validationDecisions.length > 0) {
        sections.push(
          `[untrusted_context] Validation history: ${input.evaluation.validationDecisions
            .map((decision) => `${decision.command.join(" ")}:${decision.status}`)
            .join(" | ")}`,
        );
      }
      sources.push({
        kind: "evaluation",
        label: "Evaluation result",
        artifact: this.artifactStore.resolve("evaluation.json"),
        trustLevel: "untrusted_context",
      });
    }

    if ((input.revisions?.length ?? 0) > 0) {
      const recentRevisions = input.revisions!.slice(-5);
      sections.push(
        `[untrusted_context] Revision history: ${recentRevisions
          .map((revision) => `iter${revision.iteration}:${revision.evaluationStatus}:${revision.requiredRevisions.join(" / ") || "none"}`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "revision",
        label: "Revision history",
        artifact: this.artifactStore.resolve("revisions.json"),
        trustLevel: "untrusted_context",
      });
    }

    if ((input.approvals?.length ?? 0) > 0) {
      const recentApprovals = input.approvals!.slice(-5);
      sections.push(
        `[untrusted_context] Approvals: ${recentApprovals
          .map((approval) => `${approval.toolName}:${approval.status}${approval.stepId ? `@${approval.stepId}` : ""}`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "approval",
        label: "Approval decisions",
        artifact: this.artifactStore.resolve("approvals.json"),
        trustLevel: "untrusted_context",
      });
    }

    if ((input.stepTrace?.length ?? 0) > 0) {
      const recentSteps = input.stepTrace!.slice(-5);
      sections.push(
        `[untrusted_context] Recent step trace: ${recentSteps
          .map((step) => `${step.stepId}:${step.chosenActionName}:${step.resultSummary ?? "pending"}`)
          .join(" | ")}`,
      );
      sources.push({
        kind: "step_trace",
        label: "Executor step trace",
        artifact: this.artifactStore.resolve("step-trace.jsonl"),
        trustLevel: "untrusted_context",
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
