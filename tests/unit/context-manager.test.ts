import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContextManager } from "../../src/context/manager.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";

describe("ContextManager", () => {
  it("assembles persisted context with source attribution", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-context-"));
    const artifactStore = new ArtifactStore(path.join(workspace, ".runs"), "run-1");
    await artifactStore.init();

    const manager = new ContextManager(artifactStore);
    const snapshot = await manager.assemble({
      agent: "executor",
      request: {
        task: "Create file hello.txt with content hello",
        workingDirectory: workspace,
        profile: "default",
        dryRun: false,
        maxIterations: 2,
        metadata: {},
      },
      state: {
        runId: "run-1",
        status: "executing",
        phase: "execution",
        iteration: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifactDirectory: artifactStore.runDirectory,
      },
      analysis: {
        objective: "Create file hello.txt with content hello",
        assumptions: [],
        unknowns: [],
        successCriteria: ["File exists"],
        requiredTools: ["fs.write"],
        riskLevel: "low",
        plan: [
          {
            id: "write-file",
            title: "Write file",
            description: "Write the file",
            agent: "executor",
            toolNames: ["fs.write"],
            expectedOutput: "file written",
            approvalRequired: false,
          },
        ],
      },
      execution: {
        completedSteps: [],
        skippedSteps: [],
        toolCalls: [],
        changedFiles: [],
        producedArtifacts: [],
        blockers: [],
        needsEvaluation: false,
        summary: "Prepared to execute step.",
      },
      stepTrace: [
        {
          stepId: "write-file",
          observation: "Need to write file",
          chosenActionType: "tool_call",
          chosenActionName: "fs.write",
          rationaleSummary: "The file must be created.",
          resultSummary: "Pending",
        },
      ],
      approvals: [],
      maxChars: 1_200,
    });

    expect(snapshot.agent).toBe("executor");
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.summary).toContain("User task:");
    expect(snapshot.summary).toContain("Plan steps:");
  });

  it("compacts oversized context summaries", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-context-compact-"));
    const artifactStore = new ArtifactStore(path.join(workspace, ".runs"), "run-1");
    await artifactStore.init();

    const manager = new ContextManager(artifactStore);
    const snapshot = await manager.assemble({
      agent: "analyzer",
      request: {
        task: "Analyze a very large request",
        workingDirectory: workspace,
        profile: "default",
        dryRun: true,
        maxIterations: 1,
        metadata: {},
      },
      state: {
        runId: "run-1",
        status: "planning",
        phase: "analysis",
        iteration: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifactDirectory: artifactStore.runDirectory,
      },
      stepTrace: Array.from({ length: 20 }, (_, index) => ({
        stepId: `step-${index}`,
        observation: "x".repeat(100),
        chosenActionType: "tool_call",
        chosenActionName: "fs.read",
        rationaleSummary: "y".repeat(100),
        resultSummary: "z".repeat(100),
      })),
      maxChars: 300,
    });

    expect(snapshot.compacted).toBe(true);
    expect(snapshot.summary).toContain("[...compacted...]");
    expect(snapshot.promptChars).toBeLessThanOrEqual(350);
  });
});
