import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runChatCommand } from "../../src/chat/interactive.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";
import type { RunRequest, Settings } from "../../src/schemas.js";

describe("chat cli", () => {
  it("starts a session, persists chat state, and links the user message to a run", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-cli-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["Create file hello.txt with content hello", "/exit"]);
    const requests: RunRequest[] = [];

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: false,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: () =>
          ({
            run: (request: RunRequest) => {
              requests.push(request);
              return Promise.resolve(createRunResult("run-1", artifactDir, "completed"));
            },
            resume: () => Promise.reject(new Error("resume should not be called")),
          }) as never,
      },
    );

    const sessionId = requests[0]?.metadata.sessionId;
    expect(sessionId).toBeDefined();
    expect(requests[0]?.conversationContext?.sessionId).toBe(sessionId);

    const session = JSON.parse(await readFile(path.join(artifactDir, "chat", sessionId!, "session.json"), "utf8")) as {
      turns: number;
      lastRunStatus: string;
    };
    const turns = await readFile(path.join(artifactDir, "chat", sessionId!, "turns.jsonl"), "utf8");

    expect(session.turns).toBe(2);
    expect(session.lastRunStatus).toBe("completed");
    expect(turns).toContain("Create file hello.txt with content hello");
    expect(turns).toContain("Run run-1 finished with status completed.");
  });

  it("resets into a fresh session and stops reusing prior conversation context", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-reset-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole([
      "Create file alpha.txt with content one",
      "/reset",
      "Append two to that file",
      "/exit",
    ]);
    const requests: RunRequest[] = [];

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: false,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: () =>
          ({
            run: (request: RunRequest) => {
              requests.push(request);
              return Promise.resolve(createRunResult(`run-${requests.length}`, artifactDir, "completed"));
            },
            resume: () => Promise.reject(new Error("resume should not be called")),
          }) as never,
      },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.metadata.sessionId).not.toBe(requests[1]?.metadata.sessionId);
    expect(requests[1]?.conversationContext?.includedArtifactRefs).toHaveLength(0);
  });

  it("re-enters the orchestrator resume flow from /resume", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-resume-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["/resume blocked-run", "/exit"]);
    const resumedRunIds: string[] = [];

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: false,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: () =>
          ({
            run: () => Promise.reject(new Error("run should not be called")),
            resume: (runId: string) => {
              resumedRunIds.push(runId);
              return Promise.resolve(createRunResult(runId, artifactDir, "completed"));
            },
          }) as never,
      },
    );

    expect(resumedRunIds).toEqual(["blocked-run"]);
  });

  it("lists and updates durable approvals from chat commands", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-approvals-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole([
      "Create file gated.txt with content gated",
      "/approvals",
      "/approve approval-1",
      "/deny approval-2",
      "/approvals",
      "/exit",
    ]);

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: false,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: () =>
          ({
            run: async () => {
              const artifactStore = new ArtifactStore(artifactDir, "run-approval");
              await artifactStore.init();
              await artifactStore.writeJson("approvals.json", [
                createApproval("approval-1", "run-approval", "pending"),
                createApproval("approval-2", "run-approval", "pending"),
              ]);
              return createRunResult("run-approval", artifactDir, "awaiting_approval");
            },
            resume: () => Promise.reject(new Error("resume should not be called")),
          }) as never,
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("approval-1");
    expect(output).toContain("approved approval-1");
    expect(output).toContain("denied approval-2");
    expect(output).toContain("No pending approvals.");
  });

  it("fails clearly when chat is invoked without a TTY", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-notty-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);

    await expect(
      runChatCommand(
        {
          cwd: workspace,
          profile: "default",
          dryRun: false,
          output: "text",
          stream: false,
        },
        {
          console: new FakeConsole([], false),
          loadSettings: () => Promise.resolve(settings),
        },
      ),
    ).rejects.toThrow(/interactive TTY/);
  });
});

class FakeConsole {
  public readonly output: string[] = [];
  private index = 0;

  public constructor(
    private readonly inputs: string[],
    private readonly tty = true,
  ) {}

  public isTTY(): boolean {
    return this.tty;
  }

  public prompt(label: string): Promise<string> {
    this.output.push(label);
    const value = this.inputs[this.index];
    this.index += 1;
    return Promise.resolve(value ?? "/exit");
  }

  public writeLine(line: string): void {
    this.output.push(line);
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

function createSettings(workspace: string, artifactDir: string): Settings {
  return {
    env: "test",
    logLevel: "info",
    artifactDir,
    llmProvider: "mock",
    llmModel: "mock-default",
    llmRouting: {},
    maxIterations: 2,
    approvalMode: "on-risk",
    outputFormat: "text",
    stream: false,
    maxToolOutputChars: 8_000,
    commandTimeoutMs: 30_000,
    shellAllowlist: ["node", "pnpm", "git"],
    validationCommands: [],
    allowedRoots: [workspace],
    networkAllowlist: [],
    mcpServers: [],
  };
}

function createRunResult(
  runId: string,
  artifactDir: string,
  status: "completed" | "awaiting_approval",
): {
  state: {
    runId: string;
    status: "completed" | "awaiting_approval";
    phase: string;
    iteration: number;
    startedAt: string;
    updatedAt: string;
    artifactDirectory: string;
    requestArtifact?: string;
    analysisArtifact?: string;
    executionArtifact?: string;
    evaluationArtifact?: string;
    finalReportArtifact?: string;
  };
  request: RunRequest;
  analysis: undefined;
  execution: { summary: string; completedSteps: string[]; skippedSteps: string[]; toolCalls: []; changedFiles: []; producedArtifacts: []; blockers: []; needsEvaluation: boolean };
  evaluation: { status: "pass"; passedCriteria: []; failedCriteria: []; requiredRevisions: []; validationCommands: []; validationDecisions: []; productionReadinessNotes: [] };
} {
  return {
    state: {
      runId,
      status,
      phase: status,
      iteration: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactDirectory: path.join(artifactDir, runId),
    },
    request: {
      task: "",
      workingDirectory: artifactDir,
      profile: "default",
      dryRun: false,
      maxIterations: 1,
      metadata: {},
    },
    analysis: undefined,
    execution: {
      summary: "Executed 1 plan step successfully.",
      completedSteps: [],
      skippedSteps: [],
      toolCalls: [],
      changedFiles: [],
      producedArtifacts: [],
      blockers: [],
      needsEvaluation: false,
    },
    evaluation: {
      status: "pass",
      passedCriteria: [],
      failedCriteria: [],
      requiredRevisions: [],
      validationCommands: [],
      validationDecisions: [],
      productionReadinessNotes: [],
    },
  };
}

function createApproval(
  id: string,
  runId: string,
  status: "pending" | "approved" | "denied",
): {
  id: string;
  runId: string;
  createdAt: string;
  status: "pending" | "approved" | "denied";
  toolName: string;
  reason: string;
  riskLevel: "medium";
  actionSummary: string;
  inputDigest: string;
} {
  return {
    id,
    runId,
    createdAt: new Date().toISOString(),
    status,
    toolName: "fs.write",
    reason: "Approval required",
    riskLevel: "medium",
    actionSummary: "Write gated.txt",
    inputDigest: `${id}-digest`,
  };
}
