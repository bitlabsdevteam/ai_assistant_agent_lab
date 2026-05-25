import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalManager } from "../../src/harness/approvals.js";
import { createLogger } from "../../src/logger.js";
import { RunStore } from "../../src/memory/run-store.js";
import { SessionStore } from "../../src/memory/session-store.js";
import { Orchestrator } from "../../src/orchestrator.js";
import type { Settings } from "../../src/schemas.js";
import { DeterministicTestLLMClient } from "../helpers/fake-llm.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("orchestrator", () => {
  it("runs analyzer, executor, evaluator and writes artifacts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-workspace-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "openai",
      llmModel: "gpt-5.4",
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
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings), {
      llm: new DeterministicTestLLMClient(),
    });
    const result = await orchestrator.run({
      task: "Create file hello.txt with content hello world",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      selectedSkills: [],
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
      llmProvider: "openai",
      llmModel: "gpt-5.4",
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
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings), {
      llm: new DeterministicTestLLMClient(),
    });
    const initial = await orchestrator.run({
      task: "Create file gated.txt with content gated hello",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      selectedSkills: [],
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
      llmProvider: "openai",
      llmModel: "gpt-5.4",
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
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings), {
      llm: new DeterministicTestLLMClient(),
    });
    await orchestrator.run({
      task: "Create file session.txt with content sessions",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      selectedSkills: [],
      metadata: {},
    });

    const runStore = new RunStore(artifactDir);
    const runs = await runStore.listRuns();
    const sessionStore = new SessionStore(runStore.createArtifactStore(runs[0] as string));
    const sessions = await sessionStore.list();

    expect(sessions.some((session) => session.mode === "non_interactive")).toBe(true);
    expect(sessions.every((session) => session.status !== "running")).toBe(true);
  });

  it("emits typed LLM stream events through the orchestrator callback", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-stream-events-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "openai",
      llmModel: "gpt-5.4",
      llmRouting: {},
      maxIterations: 2,
      approvalMode: "on-risk",
      outputFormat: "json",
      stream: true,
      maxToolOutputChars: 8_000,
      commandTimeoutMs: 30_000,
      shellAllowlist: ["node", "pnpm", "git"],
      validationCommands: [],
      allowedRoots: [workspace],
      networkAllowlist: [],
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [],
    };

    const events: Array<{ role: string; type: string; delta?: string }> = [];
    const orchestrator = new Orchestrator(settings, createLogger(settings), {
      llm: new DeterministicTestLLMClient(),
      onLLMEvent: (event) => {
        events.push({
          role: event.role,
          type: event.type,
          ...(typeof event.delta === "string" ? { delta: event.delta } : {}),
        });
      },
    });

    await orchestrator.run({
      task: "Create file hello.txt with content hello world",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      selectedSkills: [],
      metadata: {},
    });

    expect(events.some((event) => event.role === "analyzer" && event.type === "response.output_text.delta")).toBe(true);
    expect(events.some((event) => event.role === "executor" && event.type === "response.output_text.delta")).toBe(true);
  });

  it("requests approval for non-allowlisted web.search and resumes successfully after approval", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-weather-approval-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "openai",
      llmModel: "gpt-5.4",
      llmRouting: {},
      maxIterations: 2,
      approvalMode: "on-risk",
      outputFormat: "json",
      stream: true,
      maxToolOutputChars: 8_000,
      commandTimeoutMs: 30_000,
      shellAllowlist: ["node", "pnpm", "git"],
      validationCommands: [],
      allowedRoots: [workspace],
      networkAllowlist: [],
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [],
    };

    const envText = await readFile(path.join(process.cwd(), ".env"), "utf8");
    const keyMatch = envText.match(/^PERPLEXITY_API_KEY=(.+)$/m);
    expect(keyMatch?.[1]).toBeTruthy();
    await writeFile(path.join(workspace, ".env"), `PERPLEXITY_API_KEY=${keyMatch![1]}\n`, "utf8");

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              search_id: "search-weather-approval",
              results: [
                {
                  title: "Tokyo weather",
                  url: "https://example.com/tokyo-weather",
                  snippet: "Tokyo is 24C with light rain.",
                  date: "2026-05-25",
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      ),
    );

    const orchestrator = new Orchestrator(settings, createLogger(settings), {
      llm: new DeterministicTestLLMClient(),
    });
    const initial = await orchestrator.run({
      task: "what is the weather in Tokyo?",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      selectedSkills: [],
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
    expect(approvals[0]?.toolName).toBe("web.search");
    expect(approvals[0]?.reason).toMatch(/requires approval/i);

    await approvalManager.decide(approvals[0]!.id, "approved");
    const resumed = await orchestrator.resume(runId);

    expect(resumed.state.status).toBe("completed");
    expect(resumed.execution?.toolCalls.some((record) => record.toolName === "web.search" && record.status === "success")).toBe(true);
  });

  it("selects an explicit skill, persists its provenance, and injects it into run artifacts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-skill-run-"));
    const artifactDir = path.join(workspace, ".runs");
    const skillRoot = path.join(workspace, ".little-helper", "skills", "react-debugger");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: react-debugger",
        "description: Debug React rendering, hooks, and rerender bugs.",
        "triggers:",
        "  - rerender loop",
        "tags:",
        "  - react",
        "tools:",
        "  - fs.read",
        "version: 1",
        "enabled: true",
        "---",
        "Inspect React components, hook state, and render triggers before editing.",
      ].join("\n"),
      "utf8",
    );
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "openai",
      llmModel: "gpt-5.4",
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
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings), {
      llm: new DeterministicTestLLMClient(),
    });
    const result = await orchestrator.run({
      task: "use @react-debugger to help debug this React rerender loop",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      selectedSkills: [],
      metadata: {},
    });

    expect(result.request.selectedSkills.map((skill) => skill.name)).toEqual(["react-debugger"]);
    expect(result.request.selectedSkills[0]?.reasons[0]?.type).toBe("explicit_handle");
    const runDir = path.join(artifactDir, result.state.runId);
    const selectedSkills = JSON.parse(await readFile(path.join(runDir, "selected-skills.json"), "utf8")) as Array<{
      name: string;
      reasons: Array<{ type: string }>;
    }>;
    const finalReport = await readFile(path.join(runDir, "final-report.md"), "utf8");

    expect(selectedSkills[0]?.name).toBe("react-debugger");
    expect(selectedSkills[0]?.reasons[0]?.type).toBe("explicit_handle");
    expect(finalReport).toContain("## Selected Skills");
    expect(finalReport).toContain("react-debugger");
  });

  it("redacts sealed prompt bodies from persisted artifacts while retaining prompt metadata", async () => {
    vi.stubEnv("LITTLE_HELPER_CORE_PROMPT_ANALYZER", "sealed-canary-value");
    vi.stubEnv("LITTLE_HELPER_CORE_PROMPT_EXECUTOR", "sealed-canary-value");
    vi.stubEnv("LITTLE_HELPER_CORE_PROMPT_EVALUATOR", "sealed-canary-value");

    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-prompt-redaction-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings: Settings = {
      env: "development",
      logLevel: "info",
      artifactDir,
      llmProvider: "openai",
      llmModel: "gpt-5.4",
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
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [],
    };

    const orchestrator = new Orchestrator(settings, createLogger(settings), {
      llm: new DeterministicTestLLMClient(),
    });
    const result = await orchestrator.run({
      task: "Create file redacted.txt with content safe output",
      workingDirectory: workspace,
      profile: "default",
      dryRun: false,
      maxIterations: 2,
      selectedSkills: [],
      metadata: {},
    });

    const runDir = path.join(artifactDir, result.state.runId);
    const contents = await readAllFiles(runDir);
    for (const content of contents) {
      expect(content).not.toContain("sealed-canary-value");
    }

    const promptArtifact = JSON.parse(await readFile(path.join(runDir, "prompt-envelope-analyzer.json"), "utf8")) as {
      confidential?: boolean;
      metadata?: { corePromptHash?: string };
    };
    expect(promptArtifact.confidential).toBe(true);
    expect(promptArtifact.metadata?.corePromptHash).toBeTruthy();
  });
});

async function readAllFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      values.push(...(await readAllFiles(target)));
      continue;
    }
    values.push(await readFile(target, "utf8"));
  }
  return values;
}
