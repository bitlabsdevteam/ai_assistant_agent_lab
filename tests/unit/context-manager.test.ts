import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContextManager, renderSnapshot } from "../../src/context/manager.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";

describe("ContextManager", () => {
  it("assembles persisted context with source attribution", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-context-"),
    );
    const artifactStore = new ArtifactStore(
      path.join(workspace, ".runs"),
      "run-1",
    );
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
        selectedSkills: [],
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
    });

    expect(snapshot.agent).toBe("executor");
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.summary).toContain("User task:");
    expect(snapshot.summary).toContain("Plan steps:");
    expect(snapshot.summary).toContain("[untrusted_context]");
    expect(
      snapshot.sources.some(
        (source) => source.trustLevel === "untrusted_context",
      ),
    ).toBe(true);
  });

  it("compacts oversized context summaries", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-context-compact-"),
    );
    const artifactStore = new ArtifactStore(
      path.join(workspace, ".runs"),
      "run-1",
    );
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
        selectedSkills: [],
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
    });
    const compacted = renderSnapshot(snapshot, "compact");
    const aggressive = renderSnapshot(snapshot, "aggressive");

    expect(snapshot.compacted).toBe(false);
    expect(compacted.compacted).toBe(true);
    expect(compacted.promptChars).toBeLessThan(snapshot.promptChars);
    expect(aggressive.promptChars).toBeLessThan(compacted.promptChars);
    expect(compacted.summary).toContain("Recent step trace");
  });

  it("assembles trusted editor focus from the active selection without retrieval", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-editor-focus-"),
    );
    await writeFile(
      path.join(workspace, "src.ts"),
      "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
      "utf8",
    );
    const artifactStore = new ArtifactStore(
      path.join(workspace, ".runs"),
      "run-1",
    );
    await artifactStore.init();

    const manager = new ContextManager(artifactStore);
    const snapshot = await manager.assemble({
      agent: "analyzer",
      request: {
        task: "Explain the selected function",
        workingDirectory: workspace,
        profile: "default",
        dryRun: false,
        maxIterations: 1,
        selectedSkills: [],
        metadata: {},
        editorContext: {
          workspaceId: "workspace-a",
          activeFile: "src.ts",
          selection: {
            start: { line: 1, column: 1 },
            end: { line: 3, column: 1 },
          },
          visibleRanges: [],
          openFiles: ["src.ts"],
          recentFiles: [],
          diagnostics: [],
          retrieval: {
            enabled: false,
            maxChunks: 2,
          },
        },
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
    });

    expect(snapshot.summary).toContain("Editor focus");
    expect(snapshot.summary).toContain("Selection text:");
    expect(snapshot.summary).toContain("hello ${name}");
    expect(
      snapshot.sections.some(
        (section) => section.id === "retrieved-workspace-context",
      ),
    ).toBe(false);
  });

  it("adds local code neighborhood from the active file even without a selection", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-local-neighborhood-"),
    );
    await writeFile(
      path.join(workspace, "main.ts"),
      "import { helper } from './utils';\n\nexport function run() {\n  return helper();\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(workspace, "utils.ts"),
      "export function helper() {\n  return 'ok';\n}\n",
      "utf8",
    );
    const artifactStore = new ArtifactStore(
      path.join(workspace, ".runs"),
      "run-1",
    );
    await artifactStore.init();

    const manager = new ContextManager(artifactStore);
    const snapshot = await manager.assemble({
      agent: "executor",
      request: {
        task: "Update the current file",
        workingDirectory: workspace,
        profile: "default",
        dryRun: false,
        maxIterations: 1,
        selectedSkills: [],
        metadata: {},
        editorContext: {
          workspaceId: "workspace-b",
          activeFile: "main.ts",
          visibleRanges: [
            { start: { line: 1, column: 1 }, end: { line: 5, column: 1 } },
          ],
          openFiles: ["main.ts", "utils.ts"],
          recentFiles: ["utils.ts"],
          diagnostics: [],
          retrieval: {
            enabled: true,
            maxChunks: 2,
          },
        },
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
    });

    const neighborhood = snapshot.sections.find(
      (section) => section.id === "local-code-neighborhood",
    );
    expect(neighborhood?.fullText).toContain("Imports:");
    expect(neighborhood?.fullText).toContain("Immediate dependencies:");
    expect(
      snapshot.sources.some(
        (source) =>
          source.kind === "workspace_file" && source.trustLevel === "trusted",
      ),
    ).toBe(true);
  });

  it("includes retrieved related files with provenance and drops retrieval first during aggressive compaction", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-retrieval-context-"),
    );
    await writeFile(
      path.join(workspace, "contracts.ts"),
      "export interface Greeter {\n  greet(): string;\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(workspace, "greeter.ts"),
      "import type { Greeter } from './contracts';\n\nexport class ConsoleGreeter implements Greeter {\n  greet(): string {\n    return 'hello';\n  }\n}\n",
      "utf8",
    );
    const artifactStore = new ArtifactStore(
      path.join(workspace, ".runs"),
      "run-1",
    );
    await artifactStore.init();

    const manager = new ContextManager(artifactStore);
    const snapshot = await manager.assemble({
      agent: "analyzer",
      request: {
        task: "Find where this interface is implemented",
        workingDirectory: workspace,
        profile: "default",
        dryRun: false,
        maxIterations: 1,
        selectedSkills: [],
        metadata: {},
        editorContext: {
          workspaceId: "workspace-c",
          activeFile: "contracts.ts",
          selection: {
            start: { line: 1, column: 1 },
            end: { line: 3, column: 1 },
            selectedText: "export interface Greeter {\n  greet(): string;\n}",
          },
          visibleRanges: [],
          openFiles: ["contracts.ts"],
          recentFiles: ["greeter.ts"],
          diagnostics: [],
          retrieval: {
            enabled: true,
            maxChunks: 3,
          },
        },
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
    });

    const retrieved = snapshot.sections.find(
      (section) => section.id === "retrieved-workspace-context",
    );
    expect(retrieved?.fullText).toContain("greeter.ts");
    expect(retrieved?.fullText).toContain("Provenance:");
    expect(
      snapshot.sources.some(
        (source) =>
          source.kind === "retrieved_chunk" &&
          source.trustLevel === "untrusted_context",
      ),
    ).toBe(true);

    const aggressive = renderSnapshot(snapshot, "aggressive");
    expect(aggressive.summary).toContain("Editor focus");
    expect(aggressive.summary).not.toContain("Retrieved workspace context");
  });
});
