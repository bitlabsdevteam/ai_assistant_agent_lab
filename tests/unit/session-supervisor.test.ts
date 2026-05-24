import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { SessionSupervisor } from "../../src/harness/session-supervisor.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { SessionStore } from "../../src/memory/session-store.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import type { Settings } from "../../src/schemas.js";
import { ShellTool } from "../../src/tools/shell.js";

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

describe("SessionSupervisor", () => {
  it("inspects and cancels a persisted running PTY session", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-session-supervisor-"));
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const shell = new ShellTool();
    const started = await shell.start(["node", "-e", "setTimeout(() => {}, 5000)"], {
      runId: "run-1",
      workingDirectory: workspace,
      dryRun: false,
      permissions: ["shell"],
      signal: AbortSignal.timeout(5_000),
      settings,
      artifactStore,
      policy: new PermissionPolicy(settings),
      approvals: [],
    });

    expect(started.mode).toBe("pty");
    expect(started.pid).toBeDefined();

    const sessionStore = new SessionStore(artifactStore);
    let persisted = await sessionStore.get(started.sessionId);
    for (let attempt = 0; !persisted && attempt < 10; attempt += 1) {
      await delay(25);
      persisted = await sessionStore.get(started.sessionId);
    }
    expect(persisted?.status).toBe("running");

    const supervisor = new SessionSupervisor(artifactStore);
    const inspected = await supervisor.inspect(started.sessionId);
    expect(inspected?.status).toBe("running");
    expect(inspected?.pid).toBe(started.pid);

    const cancelled = await supervisor.cancel(started.sessionId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.terminationReason).toBe("operator_cancelled");
    expect(cancelled?.endedAt).toBeDefined();

    let cancelledPersisted = await sessionStore.get(started.sessionId);
    for (let attempt = 0; cancelledPersisted?.status !== "cancelled" && attempt < 10; attempt += 1) {
      await delay(25);
      cancelledPersisted = await sessionStore.get(started.sessionId);
    }
    expect(cancelledPersisted?.status).toBe("cancelled");
  });

  it("marks stale running sessions as failed during reconciliation", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-session-reconcile-"));
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const sessionStore = new SessionStore(artifactStore);
    await sessionStore.upsert({
      sessionId: "session-1",
      command: ["node", "-e", "setTimeout(() => {}, 1000)"],
      mode: "pty",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      status: "running",
      pid: 99_999_999,
    });

    const reconciled = await new SessionSupervisor(artifactStore).reconcileRunningSessions("recovery");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.status).toBe("failed");
    expect(reconciled[0]?.terminationReason).toBe("stale_on_recovery");
    expect(reconciled[0]?.endedAt).toBeDefined();
  });
});
