import type { Logger } from "pino";

import { AppError } from "../errors.js";
import type { LLMStreamEvent } from "../llm/client.js";
import type { RunResult } from "../harness/controller.js";
import { renderApprovals } from "../rendering/approvals.js";
import { renderRunResult } from "../rendering/run-result.js";
import type { ApprovalRequest, OutputFormat, Settings, TelemetryEvent } from "../schemas.js";

export interface ApprovalWriter {
  writeLine(line: string): void;
}

export interface ApprovalManagerLike {
  load(): Promise<ApprovalRequest[]>;
  decide(id: string, status: "approved" | "denied"): Promise<ApprovalRequest | undefined>;
  snapshot(): ApprovalRequest[];
}

export interface ApprovalStreamRendererLike {
  onEvent: (event: TelemetryEvent) => void;
  onLLMEvent: (event: LLMStreamEvent) => void;
  hasStreamedAssistantContent: () => boolean;
  finish: () => void;
}

export async function handleApprovalsFlow(
  input: {
    runId: string;
    settings: Settings;
    approveId?: string;
    denyId?: string;
    resume?: boolean;
  },
  dependencies: {
    manager: ApprovalManagerLike;
    writer: ApprovalWriter;
    logger: Logger;
    createOrchestrator: (
      settings: Settings,
      logger: Logger,
      onEvent?: (event: TelemetryEvent) => void,
      onLLMEvent?: (event: LLMStreamEvent) => void,
    ) => {
      resume(runId: string): Promise<RunResult>;
    };
    createStreamRenderer: (
      outputFormat: OutputFormat,
      options?: { textMode?: "internal" | "assistant" },
    ) => ApprovalStreamRendererLike;
  },
): Promise<void> {
  await dependencies.manager.load();
  const { approveId, denyId } = input;
  let decisionSummary:
    | {
        approvalId: string;
        status: "approved" | "denied";
      }
    | undefined;

  if (approveId && denyId) {
    throw new AppError("VALIDATION_ERROR", "Choose either --approve or --deny, not both.");
  }

  if (approveId) {
    const updated = await dependencies.manager.decide(approveId, "approved");
    if (!updated) {
      throw new AppError("NOT_FOUND", `Approval request not found: ${approveId}`);
    }
    decisionSummary = {
      approvalId: approveId,
      status: "approved",
    };
    if (input.resume) {
      const llmStreamRenderer = dependencies.createStreamRenderer(input.settings.outputFormat, { textMode: "assistant" });
      const orchestrator = dependencies.createOrchestrator(
        input.settings,
        dependencies.logger,
        input.settings.stream ? llmStreamRenderer.onEvent : undefined,
        input.settings.stream ? llmStreamRenderer.onLLMEvent : undefined,
      );
      const result = await orchestrator.resume(input.runId);
      llmStreamRenderer.finish();
      renderRunResult(dependencies.writer, result, input.settings.outputFormat, {
        omitAssistantReply: llmStreamRenderer.hasStreamedAssistantContent(),
      });
      return;
    }
  }

  if (denyId) {
    const updated = await dependencies.manager.decide(denyId, "denied");
    if (!updated) {
      throw new AppError("NOT_FOUND", `Approval request not found: ${denyId}`);
    }
    decisionSummary = {
      approvalId: denyId,
      status: "denied",
    };
  }

  renderApprovals(dependencies.writer, dependencies.manager.snapshot(), input.settings.outputFormat, {
    runId: input.runId,
    ...(decisionSummary ? { decision: decisionSummary } : {}),
  });
}
