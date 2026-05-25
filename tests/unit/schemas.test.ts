import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AnalysisResultSchema,
  ChatSessionStateSchema,
  ChatTurnRecordSchema,
  ExecutorActionSchema,
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
    });

    expect(result.profile).toBe("default");
    expect(result.dryRun).toBe(false);
    expect(result.maxIterations).toBe(3);
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
      selectedModel: "gpt-5",
      recentActivitySummary: "Proposed a patch.",
    });

    expect(state.mode).toBe("suggest");
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
    expect(zodToJsonSchema(ExecutorActionSchema, "executor_action")).toMatchObject({
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
