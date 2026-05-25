import type { ArtifactStore } from "../memory/artifact-store.js";
import {
  AgentContextSnapshotSchema,
  type AgentContextSection,
  type AgentContextSnapshot,
  type AnalysisResult,
  type ApprovalRequest,
  type ContextCompactionMode,
  type EvaluationResult,
  type ExecutionReport,
  type HarnessRunState,
  type RevisionRecord,
  type RunRequest,
  type AgentStepState,
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
}

export class ContextManager {
  public constructor(private readonly artifactStore: ArtifactStore) {}

  public async assemble(input: ContextAssemblyInput): Promise<AgentContextSnapshot> {
    const sections = buildContextSections(input);
    const sources = buildContextSources(this.artifactStore, input);
    const rendered = renderSnapshotSections(sections, "full");
    const snapshot = AgentContextSnapshotSchema.parse({
      agent: input.agent,
      summary: rendered.summary,
      promptChars: rendered.summary.length,
      compacted: false,
      compactionMode: "full",
      sections,
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

export function renderSnapshot(snapshot: AgentContextSnapshot, mode: ContextCompactionMode): AgentContextSnapshot {
  const rendered = renderSnapshotSections(snapshot.sections, mode);
  return AgentContextSnapshotSchema.parse({
    ...snapshot,
    summary: rendered.summary,
    promptChars: rendered.summary.length,
    compacted: mode !== "full",
    compactionMode: mode,
  });
}

export function snapshotToPromptSections(
  snapshot: AgentContextSnapshot | undefined,
  mode: ContextCompactionMode,
): Array<{ label: string; trustLevel: "trusted" | "untrusted_context"; text: string }> {
  if (!snapshot) {
    return [];
  }
  return snapshot.sections
    .map((section) => ({
      label: section.label,
      trustLevel: section.trustLevel,
      text: resolveSectionText(section, mode),
    }))
    .filter((section) => section.text.trim().length > 0);
}

function renderSnapshotSections(
  sections: AgentContextSection[],
  mode: ContextCompactionMode,
): {
  summary: string;
} {
  return {
    summary: sections
      .map((section) => `[${section.trustLevel}] ${section.label}:\n${resolveSectionText(section, mode)}`)
      .filter((section) => section.trim().length > 0)
      .join("\n\n"),
  };
}

function resolveSectionText(section: AgentContextSection, mode: ContextCompactionMode): string {
  if (mode === "aggressive") {
    return section.aggressiveText;
  }
  if (mode === "compact") {
    return section.compactText;
  }
  return section.fullText;
}

function buildContextSections(input: ContextAssemblyInput): AgentContextSection[] {
  const sections: AgentContextSection[] = [];

  sections.push(
    createSection(
      "instruction-hierarchy",
      "Instruction hierarchy",
      "trusted",
      [
        "1. System and developer instructions",
        "2. User task",
        "3. Current persisted run state",
        "4. Retrieved evidence and prior outputs",
      ].join("\n"),
      0,
    ),
  );

  sections.push(createSection("user-task", "User task", "trusted", input.request.task, 1));

  if (input.request.conversationContext) {
    const chat = input.request.conversationContext;
    sections.push(
      createSection(
        "chat-context",
        "Chat context",
        "trusted",
        [
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
        2,
        {
          compactText: [
            `Chat session: ${chat.sessionId}`,
            `Latest user message: ${truncate(chat.latestUserMessage, 240)}`,
            `Conversation summary: ${truncate(chat.conversationSummary || "none", 240)}`,
          ].join("\n"),
          aggressiveText: `Latest user message: ${truncate(chat.latestUserMessage, 180)}`,
        },
      ),
    );
  }

  if (input.request.selectedSkills.length > 0) {
    const full = input.request.selectedSkills
      .map((skill) => `${skill.name}[${skill.scope}]: ${skill.reasons.map((reason) => reason.detail).join("; ")}`)
      .join(" | ");
    sections.push(
      createSection("selected-skills", "Selected skills", "trusted", full, 3, {
        compactText: truncate(full, 360),
        aggressiveText: truncate(full, 180),
      }),
    );
  }

  sections.push(
    createSection(
      "run-state",
      "Run state",
      "trusted",
      `status=${input.state.status}, phase=${input.state.phase}, iteration=${input.state.iteration}`,
      4,
    ),
  );

  if (input.analysis) {
    const objective = `Objective: ${input.analysis.objective}`;
    const criteria = `Success criteria: ${input.analysis.successCriteria.join("; ") || "none"}`;
    const plan = `Plan steps: ${input.analysis.plan
      .map((step) => `${step.id}:${step.title}[${step.toolNames.join(",")}]`)
      .join(" | ")}`;
    sections.push(
      createSection("analysis", "Analysis", "untrusted_context", [objective, criteria, plan].join("\n"), 5, {
        compactText: [objective, criteria, plan].join("\n"),
        aggressiveText: [objective, `Plan steps: ${truncate(plan.replace(/^Plan steps:\s*/, ""), 220)}`].join("\n"),
      }),
    );
  }

  if (input.execution) {
    const recentToolCalls = input.execution.toolCalls.slice(-5);
    const recentDiffs = input.execution.toolCalls
      .map((call) => call.diffArtifact)
      .filter((artifact): artifact is string => typeof artifact === "string")
      .slice(-5);
    const changedFiles = input.execution.changedFiles.slice(-5).join(", ") || "none";
    sections.push(
      createSection(
        "execution",
        "Execution summary",
        "untrusted_context",
        [
          `Summary: ${input.execution.summary}`,
          `Completed: ${input.execution.completedSteps.join(", ") || "none"}`,
          `Changed files: ${changedFiles}`,
          `Blockers: ${input.execution.blockers.join("; ") || "none"}`,
          recentToolCalls.length > 0
            ? `Recent tool calls: ${recentToolCalls
                .map((call) => `${call.toolName}:${call.status}${call.error ? `(${call.error})` : ""}`)
                .join(" | ")}`
            : "Recent tool calls: none",
          recentDiffs.length > 0 ? `Recent diffs: ${recentDiffs.join(" | ")}` : "Recent diffs: none",
        ].join("\n"),
        6,
        {
          compactText: [
            `Summary: ${truncate(input.execution.summary, 280)}`,
            `Changed files: ${changedFiles}`,
            `Blockers: ${truncate(input.execution.blockers.join("; ") || "none", 220)}`,
            recentToolCalls.length > 0
              ? `Recent tool calls: ${recentToolCalls
                  .slice(-3)
                  .map((call) => `${call.toolName}:${call.status}`)
                  .join(" | ")}`
              : "Recent tool calls: none",
          ].join("\n"),
          aggressiveText: [
            `Summary: ${truncate(input.execution.summary, 180)}`,
            `Changed files: ${changedFiles}`,
            `Blockers: ${truncate(input.execution.blockers.join("; ") || "none", 140)}`,
          ].join("\n"),
        },
      ),
    );
  }

  if (input.evaluation) {
    sections.push(
      createSection(
        "evaluation",
        "Evaluation summary",
        "untrusted_context",
        [
          `Status: ${input.evaluation.status}`,
          `Failed criteria: ${input.evaluation.failedCriteria.join("; ") || "none"}`,
          `Required revisions: ${input.evaluation.requiredRevisions.join("; ") || "none"}`,
        ].join("\n"),
        7,
        {
          compactText: [
            `Status: ${input.evaluation.status}`,
            `Required revisions: ${truncate(input.evaluation.requiredRevisions.join("; ") || "none", 220)}`,
          ].join("\n"),
          aggressiveText: `Status: ${input.evaluation.status}\nRequired revisions: ${truncate(
            input.evaluation.requiredRevisions.join("; ") || "none",
            140,
          )}`,
        },
      ),
    );
  }

  if ((input.revisions?.length ?? 0) > 0) {
    const recent = input.revisions!.slice(-5);
    const full = recent
      .map((revision) => `iter${revision.iteration}:${revision.evaluationStatus}:${revision.requiredRevisions.join(" / ") || "none"}`)
      .join(" | ");
    sections.push(
      createSection("revisions", "Revision history", "untrusted_context", full, 8, {
        compactText: recent
          .slice(-3)
          .map((revision) => `iter${revision.iteration}:${revision.evaluationStatus}`)
          .join(" | "),
        aggressiveText: recent.length > 0 ? `Latest revision: iter${recent.at(-1)?.iteration ?? 0}` : "Latest revision: none",
      }),
    );
  }

  if ((input.approvals?.length ?? 0) > 0) {
    const recent = input.approvals!.slice(-5);
    const full = recent
      .map((approval) => `${approval.toolName}:${approval.status}${approval.stepId ? `@${approval.stepId}` : ""}`)
      .join(" | ");
    sections.push(
      createSection("approvals", "Approvals", "untrusted_context", full, 9, {
        compactText: recent
          .slice(-3)
          .map((approval) => `${approval.toolName}:${approval.status}`)
          .join(" | "),
        aggressiveText: recent.length > 0 ? `Latest approval: ${recent.at(-1)?.toolName}:${recent.at(-1)?.status}` : "",
      }),
    );
  }

  if ((input.stepTrace?.length ?? 0) > 0) {
    const recent = input.stepTrace!.slice(-6);
    sections.push(
      createSection(
        "step-trace",
        "Recent step trace",
        "untrusted_context",
        recent
          .map((step) => `${step.stepId}:${step.chosenActionName}:${step.resultSummary ?? "pending"}`)
          .join(" | "),
        10,
        {
          compactText: recent
            .slice(-3)
            .map((step) => `${step.stepId}:${step.chosenActionName}:${truncate(step.resultSummary ?? "pending", 80)}`)
            .join(" | "),
          aggressiveText: recent
            .slice(-2)
            .map((step) => `${step.stepId}:${step.chosenActionName}`)
            .join(" | "),
        },
      ),
    );
  }

  return sections.sort((left, right) => left.priority - right.priority);
}

function buildContextSources(artifactStore: ArtifactStore, input: ContextAssemblyInput): AgentContextSnapshot["sources"] {
  const sources: AgentContextSnapshot["sources"] = [
    { kind: "instruction", label: "Instruction hierarchy", trustLevel: "trusted" },
    {
      kind: "user_task",
      label: "Run request",
      artifact: artifactStore.resolve("request.json"),
      trustLevel: "trusted",
    },
    {
      kind: "run_state",
      label: "Harness run state",
      artifact: artifactStore.resolve("harness-state.json"),
      trustLevel: "trusted",
    },
  ];

  if (input.request.conversationContext) {
    sources.push({
      kind: "chat_session",
      label: "Chat session summary",
      artifact: artifactStore.resolve("request.json"),
      trustLevel: "trusted",
    });
    for (const artifact of input.request.conversationContext.includedArtifactRefs) {
      sources.push({
        kind: "chat_session",
        label: "Referenced chat artifact",
        artifact,
        trustLevel: "untrusted_context",
      });
    }
  }

  if (input.request.selectedSkills.length > 0) {
    sources.push({
      kind: "skill",
      label: "Selected skills",
      artifact: artifactStore.resolve("selected-skills.json"),
      trustLevel: "trusted",
    });
  }

  if (input.analysis) {
    sources.push({
      kind: "analysis",
      label: "Analyzer result",
      artifact: artifactStore.resolve("analysis.json"),
      trustLevel: "untrusted_context",
    });
  }

  if (input.execution) {
    sources.push({
      kind: "execution",
      label: "Execution report",
      artifact: artifactStore.resolve("execution.json"),
      trustLevel: "untrusted_context",
    });
    if (input.execution.toolCalls.length > 0) {
      sources.push({
        kind: "tool_output",
        label: "Execution tool calls",
        artifact: artifactStore.resolve("tool-calls.json"),
        trustLevel: "untrusted_context",
      });
    }
  }

  if (input.evaluation) {
    sources.push({
      kind: "evaluation",
      label: "Evaluation result",
      artifact: artifactStore.resolve("evaluation.json"),
      trustLevel: "untrusted_context",
    });
  }

  if ((input.revisions?.length ?? 0) > 0) {
    sources.push({
      kind: "revision",
      label: "Revision history",
      artifact: artifactStore.resolve("revisions.json"),
      trustLevel: "untrusted_context",
    });
  }

  if ((input.approvals?.length ?? 0) > 0) {
    sources.push({
      kind: "approval",
      label: "Approval decisions",
      artifact: artifactStore.resolve("approvals.json"),
      trustLevel: "untrusted_context",
    });
  }

  if ((input.stepTrace?.length ?? 0) > 0) {
    sources.push({
      kind: "step_trace",
      label: "Executor step trace",
      artifact: artifactStore.resolve("step-trace.jsonl"),
      trustLevel: "untrusted_context",
    });
  }

  return sources;
}

function createSection(
  id: string,
  label: string,
  trustLevel: "trusted" | "untrusted_context",
  fullText: string,
  priority: number,
  overrides?: {
    compactText?: string;
    aggressiveText?: string;
  },
): AgentContextSection {
  return {
    id,
    label,
    trustLevel,
    fullText,
    compactText: overrides?.compactText ?? fullText,
    aggressiveText: overrides?.aggressiveText ?? overrides?.compactText ?? fullText,
    priority,
  };
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 16))} [...trimmed...]`;
}
