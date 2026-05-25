import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { runChatCommand } from "../../src/chat/interactive.js";
import { loadSettings } from "../../src/config.js";
import type { LLMClient, LLMGenerateRequest, LLMGenerateResponse } from "../../src/llm/client.js";
import { renderPromptEnvelopeForTransport } from "../../src/llm/prompts.js";
import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { Orchestrator } from "../../src/orchestrator.js";
import {
  AnalysisResultSchema,
  EvaluationResultSchema,
  ExecutorActionSchema,
  type RunRequest,
  type Settings,
} from "../../src/schemas.js";
import { DeterministicTestLLMClient } from "../helpers/fake-llm.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    expect(console.output.join("\n")).toContain("Run run-1 finished with status completed.");
    expect(console.output.join("\n")).not.toContain("## Analyzer Response");
  });

  it("shows a transient working indicator before streamed assistant output and clears it before the next prompt", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-working-indicator-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["Say hello", "/exit"]);

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: true,
      },
      {
        console,
        loadSettings: () => Promise.resolve({ ...settings, stream: true }),
        createOrchestrator: (_settings, _logger, onEvent, onLLMEvent) =>
          ({
            run: () =>
              new Promise((resolve) => {
                onEvent?.({
                  runId: "run-working",
                  event: "harness.run_started",
                  status: "success",
                  timestamp: new Date().toISOString(),
                });
                setTimeout(() => {
                  onLLMEvent?.({
                    role: "executor",
                    type: "response.output_text.delta",
                    delta: '{"stepId":"respond","actionType":"final_response","rationaleSummary":"Reply directly.","finalResponse":"Hello from chat."}',
                    stepId: "respond",
                    stepTitle: "Respond",
                    stepHasTools: false,
                  });
                  onLLMEvent?.({
                    role: "executor",
                    type: "response.completed",
                    stepId: "respond",
                    stepTitle: "Respond",
                    stepHasTools: false,
                  });
                }, 450);
                setTimeout(() => resolve(createRunResult("run-working", artifactDir, "completed", "Hello from chat.")), 500);
              }),
            resume: () => Promise.reject(new Error("resume should not be called")),
          }) as never,
      },
    );

    expect(console.output.some((entry) => stripAnsi(entry).includes("Working."))).toBe(true);
    expect(countOccurrences(console.output.join(""), "Hello from chat.")).toBe(1);
    expect(console.output.filter((entry) => entry.includes("> ")).every((entry) => !entry.includes("Working"))).toBe(true);
  }, 10_000);

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
            run: async () => {
              const artifactStore = new ArtifactStore(artifactDir, "run-approval");
              await artifactStore.init();
              await artifactStore.writeJson("approvals.json", [
                createApproval("approval-1", "run-approval", "pending"),
                createApproval("approval-2", "run-approval", "pending"),
              ]);
              return createRunResult("run-approval", artifactDir, "awaiting_approval");
            },
            resume: async (runId: string) => {
              resumedRunIds.push(runId);
              return createRunResult(runId, artifactDir, "awaiting_approval");
            },
          }) as never,
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("approval-1");
    expect(resumedRunIds).toEqual(["run-approval"]);
    expect(output).toContain("Denied approval-2 for run run-approval.");
    expect(output).toContain("No pending approvals.");
  });

  it("treats plain approval input as continuation of the blocked run and resumes it", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-implicit-approve-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["what is the weather in Tokyo?", "approve", "/exit"]);
    let runCount = 0;
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
            run: async () => {
              runCount += 1;
              const artifactStore = new ArtifactStore(artifactDir, "run-approval");
              await artifactStore.init();
              await artifactStore.writeJson("approvals.json", [
                createApproval("approval-implicit", "run-approval", "pending"),
              ]);
              return createRunResult("run-approval", artifactDir, "awaiting_approval");
            },
            resume: async (runId: string) => {
              resumedRunIds.push(runId);
              return createRunResult(runId, artifactDir, "completed");
            },
          }) as never,
      },
    );

    expect(runCount).toBe(1);
    expect(resumedRunIds).toEqual(["run-approval"]);
    const output = console.output.join("\n");
    expect(output).not.toContain("Approval received. The pending run may proceed.");
    expect(output).not.toContain("Usage: /approve <approvalId>");
  });

  it("accepts natural approval phrasing like 'go ahead' for a single pending approval", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-natural-approve-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["what is the weather in Tokyo?", "go ahead", "/exit"]);
    let runCount = 0;
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
            run: async () => {
              runCount += 1;
              const artifactStore = new ArtifactStore(artifactDir, "run-natural-approval");
              await artifactStore.init();
              await artifactStore.writeJson("approvals.json", [
                createApproval("approval-natural", "run-natural-approval", "pending"),
              ]);
              return createRunResult("run-natural-approval", artifactDir, "awaiting_approval");
            },
            resume: async (runId: string) => {
              resumedRunIds.push(runId);
              return createRunResult(runId, artifactDir, "completed");
            },
          }) as never,
      },
    );

    expect(runCount).toBe(1);
    expect(resumedRunIds).toEqual(["run-natural-approval"]);
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

  it("loads OPENAI_API_KEY from the workspace .env during the real chat path", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-dotenv-"));
    const artifactDir = path.join(workspace, ".runs");
    await writeFile(path.join(workspace, ".env"), "OPENAI_API_KEY=chat-test-key\n", "utf8");
    const console = new FakeConsole(["hello", "/exit"]);
    const originalKey = process.env.OPENAI_API_KEY;

    try {
      delete process.env.OPENAI_API_KEY;

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
          createOrchestrator: () =>
            ({
              run: () => {
                expect(process.env.OPENAI_API_KEY).toBe("chat-test-key");
                return Promise.resolve(createRunResult("run-dotenv", artifactDir, "completed"));
              },
              resume: () => Promise.reject(new Error("resume should not be called")),
            }) as never,
        },
      );
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("renders concise streamed LLM summaries in chat when streaming is enabled", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-stream-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["Create file hello.txt with content hello", "/exit"]);

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: true,
        mode: "auto-edit",
      },
      {
        console,
        loadSettings: () => Promise.resolve({ ...settings, stream: true }),
        createOrchestrator: (resolvedSettings, logger, onEvent, onLLMEvent) =>
          new Orchestrator(resolvedSettings, logger, {
            llm: new DeterministicTestLLMClient(),
            ...(onEvent ? { onEvent } : {}),
            ...(onLLMEvent ? { onLLMEvent } : {}),
          }),
      },
    );

    const output = normalizeConsoleOutput(console.output);
    expect(output).toContain("Created hello.txt with the requested content.");
    expect(output).toContain("Inspecting workspace");
    expect(output).not.toContain("\"objective\": \"Create file hello.txt with content hello\"");
    expect(output).not.toContain("Thinking");
    expect(output).not.toContain("Working");
    expect(output).not.toContain("Checking");
  });

  it("passes trivial conversational runs in one streamed iteration without checkpoint noise", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-trivial-stream-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "chat-trivial-stream",
        version: "1.0.0",
        scripts: {
          test: "node -e \"process.exit(1)\"",
        },
      }),
      "utf8",
    );
    const console = new FakeConsole(["hello", "/exit"]);

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: true,
      },
      {
        console,
        loadSettings: () => Promise.resolve({ ...settings, stream: true }),
        createOrchestrator: (resolvedSettings, logger, onEvent, onLLMEvent) =>
          new Orchestrator(resolvedSettings, logger, {
            llm: new DeterministicTestLLMClient(),
            ...(onEvent ? { onEvent } : {}),
            ...(onLLMEvent ? { onLLMEvent } : {}),
          }),
      },
    );

    const output = normalizeConsoleOutput(console.output);
    expect(output).toContain("Hello! How can I help today?");
    expect(countOccurrences(output, "Hello! How can I help today?")).toBe(1);
    expect(output).not.toContain("Thinking");
    expect(output).not.toContain("run:");
    expect(output).not.toContain("needs_revision");
    expect(output).not.toContain("Working");
    expect(output).not.toContain("Checking");
  });

  it("uses web.search for current weather requests and answers without exposing internal agent traces", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-weather-stream-"));
    const artifactDir = path.join(workspace, ".runs");
    await writeFile(path.join(workspace, ".env"), "PERPLEXITY_API_KEY=test-perplexity-key\n", "utf8");
    const settings = {
      ...createSettings(workspace, artifactDir),
      stream: true,
      networkAllowlist: ["api.perplexity.ai"],
    };
    const console = new FakeConsole(["what is the weather in Tokyo?", "/exit"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              search_id: "search-weather",
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

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: true,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: (resolvedSettings, logger, onEvent, onLLMEvent) =>
          new Orchestrator(resolvedSettings, logger, {
            llm: new DeterministicTestLLMClient(),
            ...(onEvent ? { onEvent } : {}),
            ...(onLLMEvent ? { onLLMEvent } : {}),
          }),
      },
    );

    const output = normalizeConsoleOutput(console.output);
    expect(output).toContain('Found 1 web result(s) for "what is the weather in Tokyo?". Top result: Tokyo weather - Tokyo is 24C with light rain.');
    expect(countOccurrences(output, 'Found 1 web result(s) for "what is the weather in Tokyo?". Top result: Tokyo weather - Tokyo is 24C with light rain.')).toBe(1);
    expect(output).not.toContain("Thinking");
    expect(output).toContain("Searching the web");
    expect(output).toContain("Finished searching the web");
    expect(output).not.toContain("run:");
    expect(output).not.toContain("Working");
    expect(output).not.toContain("Checking");
  });

  it("resumes the original weather task after approve and returns the task result", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-weather-approval-resume-"));
    const artifactDir = path.join(workspace, ".runs");
    await writeFile(path.join(workspace, ".env"), "PERPLEXITY_API_KEY=test-perplexity-key\n", "utf8");
    const settings = {
      ...createSettings(workspace, artifactDir),
      stream: true,
      networkAllowlist: [],
    };
    const console = new FakeConsole(["what is the weather in Tokyo?", "approve", "/exit"]);

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

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: true,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: (resolvedSettings, logger, onEvent, onLLMEvent) =>
          new Orchestrator(resolvedSettings, logger, {
            llm: new DeterministicTestLLMClient(),
            ...(onEvent ? { onEvent } : {}),
            ...(onLLMEvent ? { onLLMEvent } : {}),
          }),
      },
    );

    const output = normalizeConsoleOutput(console.output);
    expect(output).toContain("I need approval to search the web before I can continue.");
    expect(output).toContain("Network access needs approval.");
    expect(output).toContain("Agent is accessing the web search tool. Yes or No.");
    expect(output).toContain("Searching the web");
    expect(output).toContain("Finished searching the web");
    expect(output).toContain('Found 1 web result(s) for "what is the weather in Tokyo?". Top result: Tokyo weather - Tokyo is 24C with light rain.');
    expect(countOccurrences(output, 'Found 1 web result(s) for "what is the weather in Tokyo?". Top result: Tokyo weather - Tokyo is 24C with light rain.')).toBe(1);
    expect(output).not.toContain("Approval received. The pending run may proceed.");
    expect(output).not.toContain("Approval requested:");
    expect(output).not.toContain("Awaiting approval");
    expect(output).not.toContain("Approval needed to search the web");
    expect(output).not.toContain("Thinking");
    expect(output).not.toContain("Working");
    expect(output).not.toContain("Checking");
    const runDirs = (await readdir(artifactDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "chat")
      .map((entry) => entry.name);
    expect(runDirs).toHaveLength(1);
  });

  it("replays the approved web search input instead of asking for approval again when executor input drifts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-weather-approval-drift-"));
    const artifactDir = path.join(workspace, ".runs");
    await writeFile(path.join(workspace, ".env"), "PERPLEXITY_API_KEY=test-perplexity-key\n", "utf8");
    const settings = {
      ...createSettings(workspace, artifactDir),
      stream: true,
      networkAllowlist: [],
    };
    const console = new FakeConsole(["what is the weather today in Tokyo?", "approve", "/exit"]);

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              search_id: "search-weather-drift",
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

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: true,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: (resolvedSettings, logger, onEvent, onLLMEvent) =>
          new Orchestrator(resolvedSettings, logger, {
            llm: new ApprovalDriftWeatherLLMClient(),
            ...(onEvent ? { onEvent } : {}),
            ...(onLLMEvent ? { onLLMEvent } : {}),
          }),
      },
    );

    const output = normalizeConsoleOutput(console.output);
    expect(countOccurrences(output, "I need approval to search the web before I can continue.")).toBe(1);
    expect(countOccurrences(output, "Network access needs approval.")).toBe(1);
    expect(output).toContain("Finished searching the web");
    expect(output).toContain('Found 1 web result(s) for "weather today Tokyo". Top result: Tokyo weather - Tokyo is 24C with light rain.');
  });

  it("renders turn errors in-session and keeps chat alive", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-turn-error-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["hello", "/status", "/exit"]);

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
            run: () => Promise.reject(new Error("synthetic llm failure")),
            resume: () => Promise.reject(new Error("resume should not be called")),
          }) as never,
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("Error [INTERNAL_ERROR]: synthetic llm failure");
    expect(output).toContain("status: idle");
  });

  it("renders command errors in-session and keeps chat alive", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-command-error-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["/approve", "/status", "/exit"]);

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
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("Error [NOT_FOUND]: No pending approvals.");
    expect(output).toContain("status: idle");
  });

  it("renders a compact single-approval prompt with approve guidance", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-single-approval-render-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["Create file gated.txt with content gated", "/exit"]);

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
              const artifactStore = new ArtifactStore(artifactDir, "run-single-approval");
              await artifactStore.init();
              await artifactStore.writeJson("approvals.json", [
                createApproval("approval-render", "run-single-approval", "pending"),
              ]);
              return {
                ...createRunResult("run-single-approval", artifactDir, "awaiting_approval"),
                execution: {
                  summary: "Execution completed with 1 blocker(s).",
                  completedSteps: [],
                  skippedSteps: ["respond"],
                  toolCalls: [
                    {
                      id: "run-single-approval-fs.write",
                      toolName: "fs.write",
                      category: "edit" as const,
                      inputSummary: "{\"path\":\"gated.txt\"}",
                      status: "skipped" as const,
                      startedAt: new Date().toISOString(),
                      completedAt: new Date().toISOString(),
                      approvalProvenance: "pending" as const,
                      error: "Approval required",
                    },
                  ],
                  changedFiles: [],
                  producedArtifacts: [],
                  blockers: ["Approval required"],
                  needsEvaluation: false,
                },
              };
            },
            resume: () => Promise.reject(new Error("resume should not be called")),
          }) as never,
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("I need approval to edit files before I can continue.");
    expect(output).toContain("This action needs approval.");
    expect(output).toContain("Agent is trying to edit files. Yes or No.");
    expect(output).not.toContain("Approval requested: Edit files.");
    expect(console.output.some((entry) => entry.includes("(approval)> "))).toBe(true);
    expect(output).not.toContain("run:");
  });

  it("renders multiple approvals without leaking run ids or raw policy formatting", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-multi-approval-render-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["/approvals", "/exit"]);
    const sessionId = "session-multi-approval";
    await mkdir(path.join(artifactDir, "chat", sessionId), { recursive: true });

    await writeFile(
      path.join(artifactDir, "chat", sessionId, "session.json"),
      JSON.stringify({
        sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workingDirectory: workspace,
        status: "awaiting_approval",
        turns: 0,
        pendingApprovalIds: ["approval-1", "approval-2"],
      }),
      "utf8",
    );
    await writeFile(
      path.join(artifactDir, "chat", sessionId, "turns.jsonl"),
      [
        JSON.stringify({
          turnId: "turn-1",
          role: "assistant",
          content: "Approval pending for edit.",
          timestamp: new Date().toISOString(),
          runId: "run-multi-approval",
          artifactRefs: [],
          summary: "Approval pending",
        }),
        JSON.stringify({
          turnId: "turn-2",
          role: "assistant",
          content: "Approval pending for web search.",
          timestamp: new Date().toISOString(),
          runId: "run-multi-approval-2",
          artifactRefs: [],
          summary: "Approval pending",
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(artifactDir, "chat", sessionId, "interactive-session.json"),
      JSON.stringify({
        sessionId,
        updatedAt: new Date().toISOString(),
        mode: "suggest",
        recentActivitySummary: "",
      }),
      "utf8",
    );

    const approvalsStore = new ArtifactStore(artifactDir, "run-multi-approval");
    await approvalsStore.init();
    await approvalsStore.writeJson("approvals.json", [
      createApproval("approval-1", "run-multi-approval", "pending"),
      {
        ...createApproval("approval-2", "run-multi-approval-2", "pending"),
        toolName: "web.search",
        reason: "Network target api.perplexity.ai is not allowlisted.",
      },
    ]);

    await runChatCommand(
      {
        cwd: workspace,
        profile: "default",
        dryRun: false,
        output: "text",
        stream: false,
        resume: sessionId,
      },
      {
        console,
        loadSettings: () => Promise.resolve(settings),
        createOrchestrator: () =>
          ({
            run: () => Promise.reject(new Error("run should not be called")),
            resume: () => Promise.reject(new Error("resume should not be called")),
          }) as never,
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("approval-1: Edit files. This action needs approval.");
    expect(output).toContain("approval-2: Search the web. External network access needs approval.");
    expect(output).toContain('Multiple approvals are pending. Use "/approve <approvalId>" or "/deny <approvalId>".');
    expect(output).not.toContain("run=");
    expect(output).not.toContain("reason=");
  });

  it("accepts plain deny for a single pending approval", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-implicit-deny-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["Create file blocked.txt with content blocked", "deny", "/exit"]);
    let runInvocations = 0;
    let resumeInvocations = 0;

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
              runInvocations += 1;
              const artifactStore = new ArtifactStore(artifactDir, "run-implicit-deny");
              await artifactStore.init();
              await artifactStore.writeJson("approvals.json", [
                createApproval("approval-deny", "run-implicit-deny", "pending"),
              ]);
              return {
                ...createRunResult("run-implicit-deny", artifactDir, "awaiting_approval"),
                execution: {
                  summary: "Execution completed with 1 blocker(s).",
                  completedSteps: [],
                  skippedSteps: ["respond"],
                  toolCalls: [
                    {
                      id: "run-implicit-deny-fs.write",
                      toolName: "fs.write",
                      category: "edit" as const,
                      inputSummary: "{\"path\":\"blocked.txt\"}",
                      status: "skipped" as const,
                      startedAt: new Date().toISOString(),
                      completedAt: new Date().toISOString(),
                      approvalProvenance: "pending" as const,
                      error: "Approval required",
                    },
                  ],
                  changedFiles: [],
                  producedArtifacts: [],
                  blockers: ["Approval required"],
                  needsEvaluation: false,
                },
              };
            },
            resume: async () => {
              resumeInvocations += 1;
              return createRunResult("unexpected-resume", artifactDir, "completed");
            },
          }) as never,
      },
    );

    const output = console.output.join("\n");
    expect(runInvocations).toBe(1);
    expect(resumeInvocations).toBe(0);
    expect(output).toContain("Agent is trying to edit files. Yes or No.");
    expect(output).toContain("Denied approval-deny for run run-implicit-deny.");
    expect(output).not.toContain("Approval received. The pending run may proceed.");
  });

  it("renders mcp slash help and includes the new commands in /help", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-mcp-help-"));
    const artifactDir = path.join(workspace, ".runs");
    const settings = createSettings(workspace, artifactDir);
    const console = new FakeConsole(["/mcp", "/help", "/exit"]);

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
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("/skills list");
    expect(output).toContain("/skills inspect <name>");
    expect(output).toContain("/skills add <name> [flags]");
    expect(output).toContain("/mcp list");
    expect(output).toContain("/mcp inspect <serverName>");
    expect(output).toContain("/mcp add <name>");
  });

  it("adds a skill from chat, reloads settings, and uses it on the next turn without restarting", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-skills-add-"));
    const artifactDir = path.join(workspace, ".runs");
    const console = new FakeConsole([
      '/skills add react-debugger --description "Debug React rendering and hook issues." --trigger "rerender loop" --tag react --tool fs.read',
      "/skills list",
      "/skills inspect react-debugger",
      "help debug this React rerender loop",
      "/exit",
    ]);
    const seenSelections: string[][] = [];

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
        loadSettings: async (cwd, options) => {
          return loadSettings(cwd, {
            artifactDir,
            outputFormat: options.outputFormat === "json" ? "json" : "text",
            stream: typeof options.stream === "boolean" ? options.stream : false,
          });
        },
        createOrchestrator: (settings, logger) => {
          const real = new Orchestrator(settings, logger, {
            llm: new DeterministicTestLLMClient(),
          });
          return {
            run: async (request: RunRequest) => {
              const result = await real.run(request);
              seenSelections.push(result.request.selectedSkills.map((skill) => skill.name));
              return result;
            },
            resume: (runId: string) => real.resume(runId),
          } as never;
        },
      },
    );

    const output = console.output.join("\n");
    expect(output).toContain("Added project skill 'react-debugger'");
    expect(output).toContain("react-debugger [project]");
    expect(output).toContain("Debug React rendering and hook issues.");
    expect(seenSelections).toEqual([["react-debugger"]]);
  });

  it("parses quoted mcp add args, reloads settings, and uses the added MCP server on the next turn", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-chat-mcp-add-"));
    const artifactDir = path.join(workspace, ".runs");
    const console = new FakeConsole([
      `/mcp add myserver --command node --arg "${path.resolve("tests/fixtures/mock-mcp-server.mjs")}" --arg "./folder with spaces" --allow-tool echo --allow-tool read`,
      "/mcp list",
      "Use the newly added MCP tools if available",
      "/exit",
    ]);
    const seenMCPServerCounts: number[] = [];
    let loadCount = 0;

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
        loadSettings: async (cwd, options) => {
          loadCount += 1;
          return loadSettings(cwd, {
            artifactDir,
            outputFormat: options.outputFormat === "json" ? "json" : "text",
            stream: typeof options.stream === "boolean" ? options.stream : false,
          });
        },
        createOrchestrator: (settings) => {
          seenMCPServerCounts.push(settings.mcpServers.length);
          return {
            run: () => Promise.resolve(createRunResult("run-mcp-chat", artifactDir, "completed")),
            resume: () => Promise.reject(new Error("resume should not be called")),
          } as never;
        },
      },
    );

    expect(loadCount).toBeGreaterThanOrEqual(2);
    expect(seenMCPServerCounts).toEqual([1]);
    const output = console.output.join("\n");
    expect(output).toContain("Saved MCP server 'myserver' to project config.");
    expect(output).toContain("myserver [ready]");

    const config = JSON.parse(await readFile(path.join(workspace, ".little-helper.config.json"), "utf8")) as {
      mcpServers: Array<{ args: string[]; allowedTools: string[] }>;
    };
    expect(config.mcpServers[0]?.args).toEqual([path.resolve("tests/fixtures/mock-mcp-server.mjs"), "./folder with spaces"]);
    expect(config.mcpServers[0]?.allowedTools).toEqual(["echo", "read"]);
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

  public write(text: string): void {
    this.output.push(text);
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
    llmProvider: "openai",
    llmModel: "gpt-5.4",
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
    skillDirectories: {
      project: [path.join(workspace, ".little-helper", "skills")],
      user: [path.join(workspace, ".user-skills")],
    },
    mcpServers: [],
  };
}

function normalizeConsoleOutput(output: string[]): string {
  return stripAnsi(output.join("")).replaceAll(/\s+/g, " ").trim();
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

class ApprovalDriftWeatherLLMClient implements LLMClient {
  private executorCalls = 0;

  public async generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>> {
    let object: unknown;

    if (request.role === "analyzer") {
      object = AnalysisResultSchema.parse({
        objective: "what is the weather today in Tokyo?",
        assumptions: ["Current weather should be gathered from the web search tool."],
        unknowns: [],
        successCriteria: ["Current weather information is gathered.", "A concise weather reply is produced."],
        plan: [
          {
            id: "search-weather",
            title: "Search current weather",
            description: "Search the web for current weather details in Tokyo.",
            agent: "executor",
            toolNames: ["web.search"],
            expectedOutput: "Fresh weather search results",
            approvalRequired: false,
          },
          {
            id: "respond-weather",
            title: "Respond to user",
            description: "Answer the user's weather question using the search results.",
            agent: "executor",
            toolNames: [],
            expectedOutput: "Weather answer",
            approvalRequired: false,
          },
        ],
        requiredTools: ["web.search"],
        riskLevel: "low",
      });
    } else if (request.role === "executor") {
      const input = request.input as {
        step: { id: string; toolNames: string[] };
        observation: string;
      };
      if (input.step.id === "search-weather") {
        if (input.observation.startsWith("Found ")) {
          object = ExecutorActionSchema.parse({
            stepId: "search-weather",
            observation: input.observation,
            actionType: "final_response",
            rationaleSummary: "The web search already returned current weather details.",
            finalResponse: input.observation,
          });
        } else {
          this.executorCalls += 1;
          object = ExecutorActionSchema.parse({
            stepId: "search-weather",
            observation: input.observation,
            actionType: "tool_call",
            toolName: "web.search",
            toolInput:
              this.executorCalls === 1
                ? toToolInputEntries({
                    query: "weather today Tokyo",
                    maxResults: 5,
                    searchRecencyFilter: "day",
                  })
                : toToolInputEntries({
                    query: "Tokyo weather now",
                    maxResults: 5,
                  }),
            rationaleSummary: "Search the web for current weather details.",
          });
        }
      } else {
        object = ExecutorActionSchema.parse({
          stepId: "respond-weather",
          observation: input.observation,
          actionType: "final_response",
          rationaleSummary: "Answer with the verified weather result.",
          finalResponse: input.observation,
        });
      }
    } else {
      object = EvaluationResultSchema.parse({
        status: "pass",
        passedCriteria: ["Current weather information is gathered.", "A concise weather reply is produced."],
        failedCriteria: [],
        requiredRevisions: [],
        validationCommands: [],
        validationDecisions: [],
        productionReadinessNotes: [],
      });
    }

    const parsed = schema.parse(object);
    return {
      object: parsed,
      model: "approval-drift-test",
      promptChars: renderPromptEnvelopeForTransport(request.prompt, request.input).promptChars,
      estimatedCostUsd: 0,
    };
  }

  public healthCheck(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({
      ok: true,
      message: "Approval drift weather test LLM is ready.",
    });
  }
}

function toToolInputEntries(input: Record<string, string | number | boolean>): Array<{ key: string; value: string | number | boolean }> {
  return Object.entries(input).map(([key, value]) => ({ key, value }));
}

function createRunResult(
  runId: string,
  artifactDir: string,
  status: "completed" | "awaiting_approval",
  assistantResponse?: string,
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
  analysis: {
    objective: string;
    assumptions: string[];
    unknowns: string[];
    successCriteria: string[];
    plan: Array<{
      id: string;
      title: string;
      description: string;
      agent: "executor";
      toolNames: string[];
      expectedOutput: string;
      approvalRequired: boolean;
    }>;
    requiredTools: string[];
    riskLevel: "low";
  };
  execution: {
    summary: string;
    completedSteps: string[];
    skippedSteps: string[];
    toolCalls: [];
    changedFiles: [];
    producedArtifacts: [];
    blockers: [];
    needsEvaluation: boolean;
    assistantResponse?: string;
  };
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
      selectedSkills: [],
      metadata: {},
    },
    analysis: {
      objective: "Respond to the latest user turn.",
      assumptions: [],
      unknowns: [],
      successCriteria: ["A reply is produced."],
      plan: [
        {
          id: "respond",
          title: "Respond",
          description: "Produce the requested reply.",
          agent: "executor",
          toolNames: ["fs.list"],
          expectedOutput: "Reply prepared",
          approvalRequired: false,
        },
      ],
      requiredTools: ["fs.list"],
      riskLevel: "low",
    },
    execution: {
      summary: "Executed 1 plan step successfully.",
      completedSteps: [],
      skippedSteps: [],
      toolCalls: [],
      changedFiles: [],
      producedArtifacts: [],
      blockers: [],
      needsEvaluation: false,
      ...(assistantResponse ? { assistantResponse } : {}),
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
