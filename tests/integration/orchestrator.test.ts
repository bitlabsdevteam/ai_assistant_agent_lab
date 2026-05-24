import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ApprovalManager } from "../../src/harness/approvals.js";
import { createLogger } from "../../src/logger.js";
import { RunStore } from "../../src/memory/run-store.js";
import { SessionStore } from "../../src/memory/session-store.js";
import { Orchestrator } from "../../src/orchestrator.js";
import type { Settings } from "../../src/schemas.js";

describe("orchestrator", () => {
  it("runs analyzer, executor, evaluator and writes artifacts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-workspace-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "mock",
      llmModel: "mock-default",
      llmRouting: {},
      maxIterations: 2,
      approvalMode: "on-risk",
      outputFormat: "json",
      stream: false,
      maxToolOutputChars: 8_000,
      commandTimeoutMs: 30_000,
      shellAllowlist: ["node", "pnpm", "git"],
      validationCommands: [],
      allowedRoots: [workspace],
      networkAllowlist: [],
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings));
    const result = await orchestrator.run({
      task: "Create file hello.txt with content hello world",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      metadata: {},
    });

    expect(result.state.status).toBe("completed");
    expect(await readFile(path.join(workspace, "hello.txt"), "utf8")).toBe("hello world");

    const runs = await readdir(artifactDir);
    expect(runs).toHaveLength(1);

    const runDir = path.join(artifactDir, runs[0] as string);
    const files = await readdir(runDir);
    expect(files).toContain("analysis.json");
    expect(files).toContain("diff.patch");
    expect(files).toContain("execution.json");
    expect(files).toContain("evaluation.json");
    expect(files).toContain("harness-state.json");
    expect(files).toContain("final-report.md");
  });

  it("waits for approval and resumes safely from persisted state", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-approval-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "mock",
      llmModel: "mock-default",
      llmRouting: {},
      maxIterations: 2,
      approvalMode: "always",
      outputFormat: "json",
      stream: true,
      maxToolOutputChars: 8_000,
      commandTimeoutMs: 30_000,
      shellAllowlist: ["node", "pnpm", "git"],
      validationCommands: [],
      allowedRoots: [workspace],
      networkAllowlist: [],
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings));
    const initial = await orchestrator.run({
      task: "Create file gated.txt with content gated hello",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      metadata: {},
    });

    expect(initial.state.status).toBe("awaiting_approval");

    const runStore = new RunStore(artifactDir);
    const runs = await runStore.listRuns();
    expect(runs).toHaveLength(1);
    const runId = runs[0] as string;
    const artifactStore = runStore.createArtifactStore(runId);
    const approvalManager = new ApprovalManager(artifactStore);
    const approvals = await approvalManager.load();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("pending");

    await approvalManager.decide(approvals[0]!.id, "approved");
    const resumed = await orchestrator.resume(runId);

    expect(resumed.state.status).toBe("completed");
    expect(await readFile(path.join(workspace, "gated.txt"), "utf8")).toBe("gated hello");
  });

  it("persists shell tool session summaries for auditable execution", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-session-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "mock",
      llmModel: "mock-default",
      llmRouting: {},
      maxIterations: 2,
      approvalMode: "on-risk",
      outputFormat: "json",
      stream: false,
      maxToolOutputChars: 8_000,
      commandTimeoutMs: 30_000,
      shellAllowlist: ["node", "pnpm", "git"],
      validationCommands: [["node", "-e", "console.log('session-check')"]],
      allowedRoots: [workspace],
      networkAllowlist: [],
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings));
    await orchestrator.run({
      task: "Create file session.txt with content sessions",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      metadata: {},
    });

    const runStore = new RunStore(artifactDir);
    const runs = await runStore.listRuns();
    const sessionStore = new SessionStore(runStore.createArtifactStore(runs[0] as string));
    const sessions = await sessionStore.list();

    expect(sessions.some((session) => session.mode === "non_interactive")).toBe(true);
    expect(sessions.every((session) => session.status !== "running")).toBe(true);
  });
});
