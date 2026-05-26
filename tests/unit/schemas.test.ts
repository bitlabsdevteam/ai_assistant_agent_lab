import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AnalysisResultSchema,
  ChatSessionStateSchema,
  ChatTurnRecordSchema,
  EditorContextSchema,
  ExecutorActionSchema,
  RetrievedContextChunkSchema,
  HarnessRunStateSchema,
  InteractiveSessionStateSchema,
  RunBudgetStateSchema,
  RunRequestSchema,
} from "../../src/schemas.js";
import { zodToJsonSchema } from "../../src/llm/json-schema.js";

describe("schemas", () => {
  it("applies run request defaults", () => {
    const result = RunRequestSchema.parse({
      task: "Create file hello.txt with content hello",
      workingDirectory: "/tmp/workspace",
      editorContext: {
        workspaceId: "workspace-1",
        activeFile: "src/index.ts",
        selection: {
          start: { line: 10, column: 3 },
          end: { line: 12, column: 1 },
        },
      },
    });

    expect(result.profile).toBe("default");
    expect(result.dryRun).toBe(false);
    expect(result.maxIterations).toBe(3);
    expect(result.editorContext?.visibleRanges).toEqual([]);
    expect(result.editorContext?.retrieval.maxChunks).toBe(4);
  });

  it("validates editor context payloads and retrieval provenance", () => {
    const editorContext = EditorContextSchema.parse({
      workspaceId: "workspace-1",
      activeFile: "src/example.ts",
      selection: {
        start: { offset: 10 },
        end: { offset: 42 },
        selectedText: "function example() {}",
      },
      diagnostics: [
        {
          filePath: "src/example.ts",
          severity: "warning",
          message: "unused function",
        },
      ],
    });
    const chunk = RetrievedContextChunkSchema.parse({
      chunkId: "chunk-1",
      filePath: "/tmp/workspace/src/example.ts",
      startLine: 5,
      endLine: 15,
      excerpt: "function example() {}",
      scores: {
        direct: 1,
        symbol: 0.5,
        path: 0,
        lexical: 0.5,
        semantic: 0.25,
        total: 7.25,
      },
      provenance: {
        kind: "symbol_hit",
        workspaceId: "workspace-1",
        query: "example function",
        matchedTerms: ["example", "function"],
        matchedSymbol: "example",
      },
    });

    expect(editorContext.retrieval.enabled).toBe(true);
    expect(chunk.provenance.kind).toBe("symbol_hit");
  });

  it("validates analysis results", () => {
    const result = AnalysisResultSchema.parse({
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
        },
      ],
    });

    expect(result.plan).toHaveLength(1);
  });

  it("validates harness state and budget models", () => {
    const state = HarnessRunStateSchema.parse({
      runId: "abc123",
      status: "created",
      phase: "created",
      iteration: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactDirectory: "/tmp/artifacts",
    });
    const budget = RunBudgetStateSchema.parse({
      maxIterations: 3,
    });

    expect(state.status).toBe("created");
    expect(budget.toolCallsUsed).toBe(0);
  });

  it("validates chat session and turn records", () => {
    const turn = ChatTurnRecordSchema.parse({
      turnId: "turn-1",
      role: "user",
      content: "Create file hello.txt with content hello",
      timestamp: new Date().toISOString(),
      artifactRefs: [],
    });
    const session = ChatSessionStateSchema.parse({
      sessionId: "session-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workingDirectory: "/tmp/workspace",
      status: "idle",
      turns: 1,
      conversationSummary: "",
      pendingApprovalIds: [],
      lastRunStatus: "completed",
    });

    expect(turn.role).toBe("user");
    expect(session.status).toBe("idle");
  });

  it("validates interactive session state", () => {
    const state = InteractiveSessionStateSchema.parse({
      sessionId: "session-1",
      updatedAt: new Date().toISOString(),
      mode: "suggest",
      selectedProvider: "moonshot",
      selectedModel: "gpt-5",
      recentActivitySummary: "Proposed a patch.",
    });

    expect(state.mode).toBe("suggest");
    expect(state.selectedProvider).toBe("moonshot");
    expect(state.selectedModel).toBe("gpt-5");
  });

  it("converts object schemas for OpenAI strict structured outputs", () => {
    const schema = z.object({
      requiredWithDefault: z.boolean().default(false),
      optionalText: z.string().optional(),
    });

    expect(zodToJsonSchema(schema, "strict_test")).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "strict_test",
      type: "object",
      properties: {
        requiredWithDefault: {
          type: "boolean",
        },
        optionalText: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
      required: ["requiredWithDefault", "optionalText"],
      additionalProperties: false,
    });
  });

  it("converts executor action discriminated unions for OpenAI structured outputs", () => {
    expect(
      zodToJsonSchema(ExecutorActionSchema, "executor_action"),
    ).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "executor_action",
      anyOf: expect.arrayContaining([
        expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            actionType: {
              type: "string",
              const: "tool_call",
            },
            toolInput: {
              type: "array",
              items: expect.objectContaining({
                type: "object",
                properties: expect.objectContaining({
                  key: { type: "string", minLength: 1 },
                }),
              }),
            },
          }),
        }),
        expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            actionType: {
              type: "string",
              const: "patch_proposal",
            },
          }),
        }),
      ]),
    });
  });
});
