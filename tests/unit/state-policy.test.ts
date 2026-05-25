import { describe, expect, it } from "vitest";

import { transitionRunState } from "../../src/harness/state-machine.js";
import { AppError } from "../../src/errors.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import type { HarnessRunState, Settings } from "../../src/schemas.js";

const settings: Settings = {
  env: "development",
  logLevel: "info",
  artifactDir: "/tmp/runs",
  llmProvider: "openai",
  llmModel: "gpt-5.4",
  llmRouting: {},
  maxIterations: 3,
  approvalMode: "on-risk",
  outputFormat: "text",
  stream: true,
  maxToolOutputChars: 8_000,
  commandTimeoutMs: 30_000,
  shellAllowlist: ["git", "node", "pnpm"],
  validationCommands: [["pnpm", "test"]],
  allowedRoots: ["/workspace"],
  networkAllowlist: ["example.com"],
  mcpServers: [],
};

describe("state machine and policy", () => {
  it("enforces valid state transitions", () => {
    const state: HarnessRunState = {
      runId: "run-1",
      status: "created",
      phase: "created",
      iteration: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactDirectory: "/tmp/runs/run-1",
    };

    const next = transitionRunState(state, "planning", "analysis");
    expect(next.status).toBe("planning");
    expect(() => transitionRunState(next, "completed", "finalized")).toThrow(AppError);
  });

  it("rejects paths and commands outside policy", () => {
    const policy = new PermissionPolicy(settings);

    expect(() => policy.ensurePathAllowed("/workspace/file.txt")).not.toThrow();
    expect(() => policy.ensurePathAllowed("/outside/file.txt")).toThrow(AppError);
    expect(() => policy.ensureShellAllowed(["pnpm", "test"])).not.toThrow();
    expect(() => policy.ensureShellAllowed(["rm", "-rf", "/"])).toThrow(AppError);
  });
});
