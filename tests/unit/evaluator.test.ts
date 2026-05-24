import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EvaluatorAgent } from "../../src/agents/evaluator.js";
import { ApprovalManager } from "../../src/harness/approvals.js";
import { createLogger } from "../../src/logger.js";
import { createLLMClient } from "../../src/llm/providers.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import type { AnalysisResult, ExecutionReport, Settings } from "../../src/schemas.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function createSettings(workspace: string, overrides: Partial<Settings> = {}): Settings {
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
    ...overrides,
  };
}

function createAnalysis(filePath: string, content: string): AnalysisResult {
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

function createExecution(): ExecutionReport {
  return {
    completedSteps: ["write-file"],
    skippedSteps: [],
    toolCalls: [],
    changedFiles: [],
    producedArtifacts: [],
    blockers: [],
    needsEvaluation: false,
    summary: "done",
  };
}

describe("EvaluatorAgent validation selection", () => {
  it("does not run irrelevant validation commands in an empty workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-eval-empty-"));
    await writeFile(path.join(workspace, "hello.txt"), "hello", "utf8");
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const evaluator = new EvaluatorAgent();
    const result = await evaluator.run(
      {
        analysis: createAnalysis("hello.txt", "hello"),
        execution: createExecution(),
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        settings,
        permissions: ["workspace", "shell"],
        dryRun: false,
        llm: createLLMClient(settings),
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
        stepTrace: [],
        signal: AbortSignal.timeout(5_000),
      },
    );

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual([]);
    expect(result.validationDecisions).toEqual([]);
    expect(result.productionReadinessNotes).toContain("No validation commands configured or auto-detected.");
  });

  it("auto-detects npm test from package.json when validation commands are not configured", async () => {
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
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const evaluator = new EvaluatorAgent();
    const result = await evaluator.run(
      {
        analysis: createAnalysis("hello.txt", "hello"),
        execution: createExecution(),
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        settings,
        permissions: ["workspace", "shell"],
        dryRun: false,
        llm: createLLMClient(settings),
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
        stepTrace: [],
        signal: AbortSignal.timeout(5_000),
      },
    );

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual(["npm test"]);
    expect(result.validationDecisions).toHaveLength(1);
    expect(result.validationDecisions[0]?.source).toBe("auto");
    expect(result.validationDecisions[0]?.status).toBe("passed");
    expect(result.validationDecisions[0]?.outputArtifact).toBeDefined();
  });

  it("prefers configured validation commands over auto-detection", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-eval-configured-"));
    await writeFile(path.join(workspace, "hello.txt"), "hello", "utf8");
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
    const settings = createSettings(workspace, {
      validationCommands: [["node", "-e", "process.exit(0)"]],
    });
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const evaluator = new EvaluatorAgent();
    const result = await evaluator.run(
      {
        analysis: createAnalysis("hello.txt", "hello"),
        execution: createExecution(),
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        settings,
        permissions: ["workspace", "shell"],
        dryRun: false,
        llm: createLLMClient(settings),
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
        stepTrace: [],
        signal: AbortSignal.timeout(5_000),
      },
    );

    expect(result.status).toBe("pass");
    expect(result.validationCommands).toEqual(["node -e process.exit(0)"]);
    expect(result.validationDecisions).toHaveLength(1);
    expect(result.validationDecisions[0]?.source).toBe("configured");
    expect(result.validationDecisions[0]?.status).toBe("passed");
  });
});
