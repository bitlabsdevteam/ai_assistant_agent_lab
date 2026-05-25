import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleApprovalsFlow, type ApprovalManagerLike } from "../../src/commands/approvals-command.js";
import type { ApprovalRequest, Settings } from "../../src/schemas.js";

describe("approvals command flow", () => {
  it("approves and resumes immediately when requested", async () => {
    const writes: string[] = [];
    const manager = createManager([
      createApproval("approval-1", "run-1", "pending"),
    ]);
    const resume = vi.fn(async () => ({
      state: {
        runId: "run-1",
        status: "completed",
      },
      request: {} as never,
      analysis: undefined,
      execution: {
        assistantResponse: "Tokyo is 24C with light rain.",
        blockers: [],
        toolCalls: [],
      },
      evaluation: undefined,
    }));

    await handleApprovalsFlow(
      {
        runId: "run-1",
        settings: createSettings(),
        approveId: "approval-1",
        resume: true,
      },
      {
        manager,
        writer: {
          writeLine: (line) => writes.push(line),
        },
        logger: { info() {}, error() {}, warn() {}, debug() {}, fatal() {}, trace() {}, child() { return this; } } as never,
        createOrchestrator: () =>
          ({
            resume,
          }) as never,
        createStreamRenderer: () => ({
          onEvent() {},
          onLLMEvent() {},
          hasStreamedAssistantContent: () => false,
          finish() {},
        }),
      },
    );

    expect(resume).toHaveBeenCalledWith("run-1");
    expect(writes).toEqual(["Tokyo is 24C with light rain."]);
  });
});

function createManager(approvals: ApprovalRequest[]): ApprovalManagerLike {
  const state = approvals.map((approval) => ({ ...approval }));
  return {
    load: async () => state,
    decide: async (id, status) => {
      const target = state.find((approval) => approval.id === id);
      if (!target) {
        return undefined;
      }
      target.status = status;
      target.decisionAt = new Date().toISOString();
      return target;
    },
    snapshot: () => state.map((approval) => ({ ...approval })),
  };
}

function createApproval(
  id: string,
  runId: string,
  status: "pending" | "approved" | "denied",
): ApprovalRequest {
  return {
    id,
    runId,
    createdAt: new Date().toISOString(),
    status,
    toolName: "web.search",
    reason: "Network access to 'api.perplexity.ai' requires approval because network access is disabled by default.",
    riskLevel: "medium",
    actionSummary: "Search weather",
    inputDigest: `${id}-digest`,
  };
}

function createSettings(): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: ".little-helper/runs",
    llmProvider: "openai",
    llmModel: "gpt-5.4",
    llmRouting: {},
    maxIterations: 3,
    approvalMode: "on-risk",
    outputFormat: "text",
    stream: true,
    maxToolOutputChars: 8_000,
    commandTimeoutMs: 30_000,
    shellAllowlist: ["node"],
    validationCommands: [],
    allowedRoots: [process.cwd()],
    networkAllowlist: [],
    skillDirectories: {
      project: [path.join(process.cwd(), ".little-helper", "skills")],
      user: [path.join(process.cwd(), ".user-skills")],
    },
    contextCompactionThresholdPercent: 70,
    llmContextWindows: {},
    mcpServers: [],
  };
}
