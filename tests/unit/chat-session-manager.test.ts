import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatSessionManager } from "../../src/chat/session-manager.js";

describe("chat session manager", () => {
  it("creates a session and persists session artifacts", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-chat-session-"),
    );
    const artifactDir = path.join(workspace, ".runs");
    const manager = new ChatSessionManager(artifactDir);

    const session = await manager.createSession({
      workingDirectory: workspace,
    });

    const sessionJson = JSON.parse(
      await readFile(
        path.join(artifactDir, "chat", session.sessionId, "session.json"),
        "utf8",
      ),
    ) as { sessionId: string; status: string };
    const summary = await readFile(
      path.join(artifactDir, "chat", session.sessionId, "summary.md"),
      "utf8",
    );
    const interactive = JSON.parse(
      await readFile(
        path.join(
          artifactDir,
          "chat",
          session.sessionId,
          "interactive-session.json",
        ),
        "utf8",
      ),
    ) as { mode: string };

    expect(sessionJson.sessionId).toBe(session.sessionId);
    expect(sessionJson.status).toBe("idle");
    expect(interactive.mode).toBe("suggest");
    expect(summary).toContain("Conversation Summary");
  });

  it("persists selected provider and model in interactive chat state", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-chat-provider-"),
    );
    const artifactDir = path.join(workspace, ".runs");
    const manager = new ChatSessionManager(artifactDir);

    const session = await manager.createSession({
      workingDirectory: workspace,
      selectedProvider: "gemini",
      selectedModel: "gemini-2.5-pro",
    });

    const interactive = JSON.parse(
      await readFile(
        path.join(
          artifactDir,
          "chat",
          session.sessionId,
          "interactive-session.json",
        ),
        "utf8",
      ),
    ) as { selectedProvider?: string; selectedModel?: string };

    expect(interactive.selectedProvider).toBe("gemini");
    expect(interactive.selectedModel).toBe("gemini-2.5-pro");
  });

  it("prepares linked run requests with session and conversation context", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-chat-request-"),
    );
    const artifactDir = path.join(workspace, ".runs");
    const manager = new ChatSessionManager(artifactDir);
    const session = await manager.createSession({
      workingDirectory: workspace,
    });

    const first = await manager.prepareTurn({
      sessionId: session.sessionId,
      message: "Create file hello.txt with content hello world",
      profile: "default",
      dryRun: false,
      maxIterations: 2,
    });
    await manager.completeTurn({
      sessionId: session.sessionId,
      turnId: first.turnId,
      runId: "run-1",
      assistantContent: "Run run-1 finished with status completed.",
      assistantSummary: "Created hello.txt",
      artifactRefs: ["/tmp/run-1/final-report.md"],
      runStatus: "completed",
    });

    const second = await manager.prepareTurn({
      sessionId: session.sessionId,
      message: "Append !!! to that file",
      profile: "default",
      dryRun: false,
      maxIterations: 2,
    });

    expect(first.request.metadata.sessionId).toBe(session.sessionId);
    expect(first.request.metadata.turnId).toBe(first.turnId);
    expect(second.request.conversationContext?.sessionId).toBe(
      session.sessionId,
    );
    expect(
      second.request.conversationContext?.recentTurns.some(
        (turn) => turn.runId === "run-1",
      ),
    ).toBe(true);
    expect(second.request.conversationContext?.includedArtifactRefs).toContain(
      "/tmp/run-1/final-report.md",
    );
  });

  it("carries selected provider and model into prepared run metadata", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-chat-provider-request-"),
    );
    const artifactDir = path.join(workspace, ".runs");
    const manager = new ChatSessionManager(artifactDir);
    const session = await manager.createSession({
      workingDirectory: workspace,
      selectedProvider: "anthropic",
      selectedModel: "claude-3-7-sonnet-latest",
    });

    const prepared = await manager.prepareTurn({
      sessionId: session.sessionId,
      message: "hello",
      profile: "default",
      dryRun: false,
      maxIterations: 1,
    });

    expect(prepared.request.metadata.selectedProvider).toBe("anthropic");
    expect(prepared.request.metadata.selectedModel).toBe(
      "claude-3-7-sonnet-latest",
    );
  });

  it("copies editor context into the prepared run request", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-chat-editor-context-"),
    );
    const artifactDir = path.join(workspace, ".runs");
    const manager = new ChatSessionManager(artifactDir);
    const session = await manager.createSession({
      workingDirectory: workspace,
    });

    const prepared = await manager.prepareTurn({
      sessionId: session.sessionId,
      message: "Explain the selected function",
      profile: "default",
      dryRun: false,
      maxIterations: 1,
      editorContext: {
        workspaceId: "workspace-1",
        activeFile: "src/example.ts",
        selection: {
          start: { line: 2, column: 1 },
          end: { line: 4, column: 1 },
          selectedText: "export function greet() {\n  return 'hello';\n}",
        },
        visibleRanges: [],
        openFiles: ["src/example.ts"],
        recentFiles: [],
        diagnostics: [],
        retrieval: {
          enabled: true,
          maxChunks: 2,
        },
      },
    });

    expect(prepared.request.editorContext?.workspaceId).toBe("workspace-1");
    expect(prepared.request.editorContext?.selection?.selectedText).toContain(
      "greet",
    );
    expect(prepared.request.editorContext?.retrieval.maxChunks).toBe(2);
  });

  it("compacts older turns into summary while preserving recent turns", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-chat-compact-"),
    );
    const artifactDir = path.join(workspace, ".runs");
    const manager = new ChatSessionManager(artifactDir, {
      compactionThresholdChars: 80,
      recentTurnLimit: 2,
    });
    const session = await manager.createSession({
      workingDirectory: workspace,
    });

    for (let index = 0; index < 4; index += 1) {
      const prepared = await manager.prepareTurn({
        sessionId: session.sessionId,
        message: `Create file note-${index}.txt with content this is a long content block ${index}`,
        profile: "default",
        dryRun: false,
        maxIterations: 1,
      });
      await manager.completeTurn({
        sessionId: session.sessionId,
        turnId: prepared.turnId,
        runId: `run-${index}`,
        assistantContent: `Completed run-${index}`,
        assistantSummary: `Created note-${index}.txt`,
        artifactRefs: [`/tmp/run-${index}/final-report.md`],
        runStatus: "completed",
      });
    }

    const refreshed = await manager.refreshSession(session.sessionId);
    const turns = await manager.listTurns(session.sessionId);
    const summary = await readFile(
      path.join(artifactDir, "chat", session.sessionId, "summary.md"),
      "utf8",
    );
    const next = await manager.buildConversationContext(
      session.sessionId,
      "turn-next",
      "Append more to that file",
    );

    expect(refreshed.conversationSummary.length).toBeGreaterThan(0);
    expect(summary).toContain("user:");
    expect(turns.length).toBe(8);
    expect(next.recentTurns).toHaveLength(2);
  });
});
