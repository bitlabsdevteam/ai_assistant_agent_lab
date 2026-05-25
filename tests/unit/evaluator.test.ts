import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EvaluatorAgent } from "../../src/agents/evaluator.js";
import { ApprovalManager } from "../../src/harness/approvals.js";
import { createLogger } from "../../src/logger.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import type { AgentStepState, AnalysisResult, ExecutionReport, Settings, ToolCallRecord } from "../../src/schemas.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { DeterministicTestLLMClient } from "../helpers/fake-llm.js";

function createSettings(workspace: string, overrides: Partial<Settings> = {}): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: path.join(workspace, ".runs"),
    llmProvider: "openai",
    llmModel: "gpt-5.4",
    llmRouting: {},
    maxIterations: 2,
    approvalMode: "on-risk",
    outputFormat: "json",
    stream: false,
    maxToolOutputChars: 8_000,
    commandTimeoutMs: 30_000,
    shellAllowlist: ["node", "npm", "pnpm", "git"],
    validationCommands: [],
    allowedRoots: [workspace],
    networkAllowlist: [],
    mcpServers: [],
    ...overrides,
  };
}

function createFileAnalysis(filePath: string, content: string): AnalysisResult {
  return {
    objective: `Create file ${filePath} with content ${content}`,
    assumptions: [],
    unknowns: [],
    successCriteria: [`File '${filePath}' exists with the requested content.`],
    plan: [],
    requiredTools: ["fs.write"],
    riskLevel: "low",
  };
}

function createInspectionAnalysis(objective: string): AnalysisResult {
  return {
    objective,
    assumptions: [],
    unknowns: [],
    successCriteria: ["Relevant workspace inspection completed.", "A concrete next action is identified."],
    plan: [],
    requiredTools: ["fs.list"],
    riskLevel: "low",
  };
}

function createExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    completedSteps: ["step-1"],
    skippedSteps: [],
    toolCalls: [],
    changedFiles: [],
    producedArtifacts: [],
    blockers: [],
    needsEvaluation: false,
    summary: "done",
    ...overrides,
  };
}

function createToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "tool-1",
    toolName: "fs.list",
    category: "read",
    inputSummary: "{}",
    status: "success",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createStepTrace(action: AgentStepState["chosenActionType"]): AgentStepState[] {
  return [
    {
      stepId: "inspect-workspace",
      observation: "Workspace inspected.",
      chosenActionType: action,
      chosenActionName: action === "tool_call" ? "fs.list" : action,
      rationaleSummary: "Synthetic test step.",
      resultSummary: "Synthetic result.",
    },
  ];
}

async function runEvaluator(input: {
  workspace: string;
  analysis: AnalysisResult;
  execution: ExecutionReport;
  settings?: Partial<Settings>;
  stepTrace?: AgentStepState[];
}) {
  const settings = createSettings(input.workspace, input.settings);
  const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
  await artifactStore.init();

  return new EvaluatorAgent().run(
    {
      analysis: input.analysis,
      execution: input.execution,
    },
    {
      runId: "run-1",
      workingDirectory: input.workspace,
      settings,
      permissions: ["workspace", "shell"],
      dryRun: false,
      llm: new DeterministicTestLLMClient(),
      tools: new ToolRegistry(),
      policy: new PermissionPolicy(settings),
      approvalManager: new ApprovalManager(artifactStore),
      approvals: [],
      artifactStore,
      logger: createLogger(settings),
      budget: {
        maxIterations: 2,
        toolCallsUsed: 0,
        promptCharsUsed: 0,
        estimatedCostUsd: 0,
      },
      stepTrace: input.stepTrace ?? [],
      signal: AbortSignal.timeout(5_000),
    },
  );
}

describe("EvaluatorAgent validation selection", () => {
  it("does not run irrelevant validation commands in an empty workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-eval-empty-"));
    await writeFile(path.join(workspace, "hello.txt"), "hello", "utf8");

    const result = await runEvaluator({
      workspace,
      analysis: createFileAnalysis("hello.txt", "hello"),
      execution: createExecution(),
    });

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual([]);
    expect(result.validationDecisions).toEqual([]);
    expect(result.productionReadinessNotes).toContain("No validation commands configured or auto-detected.");
  });

  it("skips auto-validation for conversational no-op runs", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-eval-conversation-"));
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "conversation-skip",
        version: "1.0.0",
        scripts: {
          test: "node -e \"process.exit(1)\"",
        },
      }),
      "utf8",
    );

    const result = await runEvaluator({
      workspace,
      analysis: createInspectionAnalysis("Respond to the user's greeting."),
      execution: createExecution({
        toolCalls: [createToolCall()],
      }),
      stepTrace: [
        ...createStepTrace("tool_call"),
        {
          stepId: "inspect-workspace",
          observation: "Reply is ready.",
          chosenActionType: "final_response",
          chosenActionName: "final_response",
          rationaleSummary: "No more work is required.",
          resultSummary: "Hello!",
        },
      ],
    });

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual([]);
    expect(result.validationDecisions).toEqual([
      {
        command: ["auto-validation"],
        source: "auto",
        status: "skipped",
        reason: "No workspace mutation or validation-worthy action performed.",
      },
    ]);
  });

  it("skips auto-validation for inspection-only runs", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-eval-inspection-"));
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "inspection-skip",
        version: "1.0.0",
        scripts: {
          test: "node -e \"process.exit(1)\"",
        },
      }),
      "utf8",
    );

    const result = await runEvaluator({
      workspace,
      analysis: createInspectionAnalysis("Inspect the workspace and describe the next step."),
      execution: createExecution({
        toolCalls: [createToolCall({ toolName: "fs.read" })],
      }),
      stepTrace: [
        ...createStepTrace("tool_call"),
        {
          stepId: "inspect-workspace",
          observation: "Inspection completed.",
          chosenActionType: "final_response",
          chosenActionName: "final_response",
          rationaleSummary: "Inspection-only task is complete.",
          resultSummary: "The workspace contains the expected files.",
        },
      ],
    });

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual([]);
    expect(result.validationDecisions[0]?.status).toBe("skipped");
    expect(result.validationDecisions[0]?.source).toBe("auto");
  });

  it("auto-detects npm test for file-edit runs when validation commands are not configured", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-eval-auto-"));
    await writeFile(path.join(workspace, "hello.txt"), "hello", "utf8");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "auto-validation",
        version: "1.0.0",
        scripts: {
          test: "node -e \"process.exit(0)\"",
        },
      }),
      "utf8",
    );

    const target = path.join(workspace, "hello.txt");
    const result = await runEvaluator({
      workspace,
      analysis: createFileAnalysis("hello.txt", "hello"),
      execution: createExecution({
        toolCalls: [createToolCall({ toolName: "fs.write", category: "edit" })],
        changedFiles: [target],
      }),
      stepTrace: createStepTrace("final_response"),
    });

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual(["npm test"]);
    expect(result.validationDecisions).toHaveLength(1);
    expect(result.validationDecisions[0]?.source).toBe("auto");
    expect(result.validationDecisions[0]?.status).toBe("passed");
    expect(result.validationDecisions[0]?.outputArtifact).toBeDefined();
  });

  it("prefers configured validation commands even for trivial runs", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-eval-configured-"));
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "configured-validation",
        version: "1.0.0",
        scripts: {
          test: "node -e \"process.exit(1)\"",
        },
      }),
      "utf8",
    );

    const result = await runEvaluator({
      workspace,
      analysis: createInspectionAnalysis("Respond to the latest user turn."),
      execution: createExecution({
        toolCalls: [createToolCall()],
      }),
      settings: {
        validationCommands: [["node", "-e", "process.exit(0)"]],
      },
      stepTrace: [
        ...createStepTrace("tool_call"),
        {
          stepId: "inspect-workspace",
          observation: "Reply is ready.",
          chosenActionType: "final_response",
          chosenActionName: "final_response",
          rationaleSummary: "The answer is ready.",
          resultSummary: "Hello!",
        },
      ],
    });

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual(["node -e process.exit(0)"]);
    expect(result.validationDecisions).toHaveLength(1);
    expect(result.validationDecisions[0]?.source).toBe("configured");
    expect(result.validationDecisions[0]?.status).toBe("passed");
  });
});
