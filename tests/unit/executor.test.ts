import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ExecutorAgent } from "../../src/agents/executor.js";
import { ApprovalManager } from "../../src/harness/approvals.js";
import { createLogger } from "../../src/logger.js";
import { createLLMClient } from "../../src/llm/providers.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import type { AnalysisResult, Settings } from "../../src/schemas.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function createSettings(workspace: string): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: path.join(workspace, ".runs"),
    llmProvider: "mock",
    llmModel: "mock-default",
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
  };
}

describe("ExecutorAgent", () => {
  it("uses a typed LLM action to execute a file creation step", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-executor-"));
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const analysis: AnalysisResult = {
      objective: "Create file hello.txt with content hello world",
      assumptions: [],
      unknowns: [],
      successCriteria: ["File 'hello.txt' exists with the requested content."],
      plan: [
        {
          id: "inspect-workspace",
          title: "Inspect workspace",
          description: "Inspect the workspace before editing.",
          agent: "executor",
          toolNames: ["fs.list"],
          expectedOutput: "Workspace listing",
          approvalRequired: false,
        },
        {
          id: "write-file",
          title: "Write file",
          description: "Write the requested file.",
          agent: "executor",
          toolNames: ["fs.write"],
          expectedOutput: "hello.txt created",
          approvalRequired: false,
        },
      ],
      requiredTools: ["fs.list", "fs.write"],
      riskLevel: "low",
    };

    const stepTrace: Array<{
      stepId: string;
      observation: string;
      chosenActionType: "tool_call" | "final_response" | "clarification";
      chosenActionName: string;
      rationaleSummary: string;
      resultSummary?: string;
    }> = [];

    const result = await new ExecutorAgent().run(
      { analysis },
      {
        runId: "run-1",
        workingDirectory: workspace,
        settings,
        permissions: ["workspace", "shell"],
        dryRun: false,
        llm: createLLMClient(settings),
        tools: await ToolRegistry.create(settings),
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
        stepTrace,
        signal: AbortSignal.timeout(5_000),
      },
    );

    expect(result.completedSteps).toEqual(["inspect-workspace", "write-file"]);
    expect(result.blockers).toEqual([]);
    expect(await readFile(path.join(workspace, "hello.txt"), "utf8")).toBe("hello world");
    expect(stepTrace).toHaveLength(4);
    expect(stepTrace[0]?.chosenActionType).toBe("tool_call");
    expect(stepTrace[1]?.chosenActionType).toBe("final_response");
    expect(stepTrace[2]?.chosenActionName).toBe("fs.write");
    expect(stepTrace[2]?.resultSummary).toContain("completed successfully");
    expect(stepTrace[3]?.chosenActionType).toBe("final_response");
  });

  it("supports model-provided input overrides with deterministic fallback for append flows", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-executor-append-"));
    await writeFile(path.join(workspace, "notes.txt"), "before ", "utf8");
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const analysis: AnalysisResult = {
      objective: "Append after to notes.txt",
      assumptions: [],
      unknowns: [],
      successCriteria: ["File 'notes.txt' contains the appended content."],
      plan: [
        {
          id: "read-file",
          title: "Read target file",
          description: "Read the file first.",
          agent: "executor",
          toolNames: ["fs.read"],
          expectedOutput: "Current content",
          approvalRequired: false,
        },
        {
          id: "patch-file",
          title: "Patch target file",
          description: "Append the content.",
          agent: "executor",
          toolNames: ["fs.write"],
          expectedOutput: "Updated file",
          approvalRequired: false,
        },
      ],
      requiredTools: ["fs.read", "fs.write"],
      riskLevel: "low",
    };

    const result = await new ExecutorAgent().run(
      { analysis },
      {
        runId: "run-1",
        workingDirectory: workspace,
        settings,
        permissions: ["workspace", "shell"],
        dryRun: false,
        llm: createLLMClient(settings),
        tools: await ToolRegistry.create(settings),
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
        stepTrace: [],
        signal: AbortSignal.timeout(5_000),
      },
    );

    expect(result.completedSteps).toEqual(["read-file", "patch-file"]);
    expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("before after");
  });
});
