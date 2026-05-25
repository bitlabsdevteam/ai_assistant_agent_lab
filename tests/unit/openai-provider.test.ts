import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLLMClient } from "../../src/llm/providers.js";
import { AnalysisResultSchema, ExecutorActionSchema } from "../../src/schemas.js";
import type { Settings } from "../../src/schemas.js";

function createSettings(baseUrl: string, overrides: Partial<Settings> = {}): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: ".little-helper/runs",
    llmProvider: "openai",
    llmModel: "gpt-5.4",
    llmBaseUrl: baseUrl,
    llmOrganization: "org_test",
    llmProject: "proj_test",
    llmRouting: {},
    maxIterations: 1,
    approvalMode: "on-risk",
    outputFormat: "text",
    stream: false,
    maxToolOutputChars: 8_000,
    commandTimeoutMs: 30_000,
    shellAllowlist: ["node"],
    validationCommands: [],
    allowedRoots: [process.cwd()],
    networkAllowlist: [],
    mcpServers: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAIResponsesClient", () => {
  it("performs a health check against the configured base URL", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(normalizeRequestUrl(input)).toBe("https://example.test/v1/models/gpt-5.4");
      expect(init).toMatchObject({
        method: "GET",
        headers: {
          authorization: "Bearer test-key",
          "OpenAI-Organization": "org_test",
          "OpenAI-Project": "proj_test",
        },
      });
      return Promise.resolve(new Response(JSON.stringify({ id: "model-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(createSettings("https://example.test/v1"), {
      OPENAI_API_KEY: "test-key",
    });
    await expect(client.healthCheck()).resolves.toEqual({
      ok: true,
      message: "OpenAI provider is reachable for model 'gpt-5.4'.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests structured output and validates the JSON response", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonBody(init?.body) as {
        model: string;
        text?: { format?: { type?: string; schema?: Record<string, unknown> } };
      };
      expect(body.model).toBe("gpt-5.4");
      expect(body.text?.format?.type).toBe("json_schema");
      expect(body.text?.format?.schema).toMatchObject({
        title: "analyzer_response",
        type: "object",
      });
      return Promise.resolve(new Response(
        JSON.stringify({
          model: "gpt-5.4",
          output_text: JSON.stringify({
            objective: "Create file hello.txt with content hello",
            assumptions: [],
            unknowns: [],
            successCriteria: ["File 'hello.txt' exists with the requested content."],
            plan: [
              {
                id: "write-file",
                title: "Write file",
                description: "Create the target file.",
                agent: "executor",
                toolNames: ["fs.write"],
                expectedOutput: "hello.txt created",
                approvalRequired: false,
              },
            ],
            requiredTools: ["fs.write"],
            riskLevel: "low",
          }),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(createSettings("https://example.test/v1"), {
      OPENAI_API_KEY: "test-key",
    });
    const schema = z.object({
      objective: z.string(),
      assumptions: z.array(z.string()),
      unknowns: z.array(z.string()),
      successCriteria: z.array(z.string()),
      plan: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string(),
          agent: z.literal("executor"),
          toolNames: z.array(z.string()),
          expectedOutput: z.string(),
          approvalRequired: z.boolean(),
        }),
      ),
      requiredTools: z.array(z.string()),
      riskLevel: z.enum(["low", "medium", "high"]),
    });

    const response = await client.generateObject(
      {
        role: "analyzer",
        prompt: "Analyze: Create file hello.txt with content hello",
        input: {},
      },
      schema,
    );

    expect(response.model).toBe("gpt-5.4");
    expect(response.object.requiredTools).toEqual(["fs.write"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "OpenAI-Organization": "org_test",
        "OpenAI-Project": "proj_test",
      },
    });
  });

  it("wraps non-object root schemas for OpenAI structured outputs", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonBody(init?.body) as {
        text?: { format?: { type?: string; schema?: Record<string, unknown> } };
      };
      expect(body.text?.format?.type).toBe("json_schema");
      expect(body.text?.format?.schema).toMatchObject({
        title: "executor_response",
        type: "object",
        properties: {
          data: {
            anyOf: expect.any(Array),
          },
        },
        required: ["data"],
        additionalProperties: false,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "gpt-5.4",
            output_text: JSON.stringify({
              data: {
                stepId: "step-1",
                observation: "Inspected the workspace.",
                actionType: "final_response",
                rationaleSummary: "No tool use is needed.",
                finalResponse: "Done.",
              },
            }),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(createSettings("https://example.test/v1"), {
      OPENAI_API_KEY: "test-key",
    });

    const response = await client.generateObject(
      {
        role: "executor",
        prompt: "Choose the next executor action",
        input: {},
      },
      ExecutorActionSchema,
    );

    expect(response.object).toEqual({
      stepId: "step-1",
      observation: "Inspected the workspace.",
      actionType: "final_response",
      rationaleSummary: "No tool use is needed.",
      finalResponse: "Done.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams SSE text deltas and still returns the validated object", async () => {
    const analysis = {
      objective: "Create file hello.txt with content hello",
      assumptions: [],
      unknowns: [],
      successCriteria: ["File 'hello.txt' exists with the requested content."],
      plan: [
        {
          id: "write-file",
          title: "Write file",
          description: "Create the target file.",
          agent: "executor",
          toolNames: ["fs.write"],
          expectedOutput: "hello.txt created",
          approvalRequired: false,
        },
      ],
      requiredTools: ["fs.write"],
      riskLevel: "low",
    };
    const rendered = JSON.stringify(analysis);
    const chunks = [rendered.slice(0, 24), rendered.slice(24)];
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          createSSEStream([
            `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: chunks[0] })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: chunks[1] })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ response: { model: "gpt-5.4", output_text: rendered } })}\n\n`,
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const events: string[] = [];
    const client = createLLMClient(createSettings("https://example.test/v1"), {
      OPENAI_API_KEY: "test-key",
    });

    const response = await client.generateObject(
      {
        role: "analyzer",
        prompt: "Analyze: Create file hello.txt with content hello",
        input: {},
        stream: {
          onTextDelta: (delta) => {
            deltas.push(delta);
          },
          onEvent: (event) => {
            events.push(event.type);
          },
        },
      },
      AnalysisResultSchema,
    );

    expect(deltas.join("")).toBe(rendered);
    expect(events).toContain("response.output_text.delta");
    expect(events).toContain("response.completed");
    expect(response.object.requiredTools).toEqual(["fs.write"]);
  });

  it("reports missing OPENAI_API_KEY in health checks", async () => {
    const client = createLLMClient(createSettings("https://example.test/v1"), {});
    await expect(client.healthCheck()).resolves.toEqual({
      ok: false,
      message: "OPENAI_API_KEY is not configured.",
    });
  });

  it("retries transient upstream HTML failures before succeeding", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<!DOCTYPE html><html><title>520</title></html>", {
          status: 520,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "gpt-5.4",
            output_text: JSON.stringify({
              objective: "Create file hello.txt with content hello",
              assumptions: [],
              unknowns: [],
              successCriteria: ["File 'hello.txt' exists with the requested content."],
              plan: [
                {
                  id: "write-file",
                  title: "Write file",
                  description: "Create the target file.",
                  agent: "executor",
                  toolNames: ["fs.write"],
                  expectedOutput: "hello.txt created",
                  approvalRequired: false,
                },
              ],
              requiredTools: ["fs.write"],
              riskLevel: "low",
            }),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(createSettings("https://example.test/v1"), {
      OPENAI_API_KEY: "test-key",
    });

    const promise = client.generateObject(
      {
        role: "analyzer",
        prompt: "Analyze: Create file hello.txt with content hello",
        input: {},
      },
      AnalysisResultSchema,
    );

    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.object.requiredTools).toEqual(["fs.write"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("routes roles to different OpenAI models when llmRouting overrides are configured", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonBody(init?.body) as {
        model?: string;
        text?: { format?: { name?: string } };
      };
      if (body.text?.format?.name === "analyzer_response") {
        expect(body.model).toBe("gpt-5.4");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: "gpt-5.4",
              output_text: JSON.stringify({
                objective: "Create file hello.txt with content hello",
                assumptions: [],
                unknowns: [],
                successCriteria: ["File 'hello.txt' exists with the requested content."],
                plan: [
                  {
                    id: "write-file",
                    title: "Write file",
                    description: "Create the target file.",
                    agent: "executor",
                    toolNames: ["fs.write"],
                    expectedOutput: "hello.txt created",
                    approvalRequired: false,
                  },
                ],
                requiredTools: ["fs.write"],
                riskLevel: "low",
              }),
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }

      expect(body.model).toBe("gpt-5.4-mini");
      expect(body.text?.format?.name).toBe("evaluator_response");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "gpt-5.4-mini",
            output_text: JSON.stringify({ verdict: "ok" }),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(
      createSettings("https://example.test/v1", {
        llmRouting: {
          evaluator: {
            provider: "openai",
            model: "gpt-5.4-mini",
            baseUrl: "https://example.test/v1",
            organization: "org_test",
            project: "proj_test",
          },
        },
      }),
      {
        OPENAI_API_KEY: "test-key",
      },
    );

    const analysis = await client.generateObject(
      {
        role: "analyzer",
        prompt: "Analyze: Create file hello.txt with content hello",
        input: {
          task: "Create file hello.txt with content hello",
          workingDirectory: "/tmp/workspace",
          profile: "default",
          dryRun: false,
          maxIterations: 1,
          metadata: {},
        },
      },
      AnalysisResultSchema,
    );
    expect(analysis.object.objective).toBe("Create file hello.txt with content hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const evaluation = await client.generateObject(
      {
        role: "evaluator",
        prompt: "Evaluate this execution",
        input: {},
      },
      z.object({ verdict: z.string() }),
    );
    expect(evaluation.object).toEqual({ verdict: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports aggregated health for mixed role routes", async () => {
    const client = createLLMClient(
      createSettings("https://example.test/v1", {
        llmRouting: {
          evaluator: {
            provider: "openai",
            model: "gpt-5.4-mini",
            baseUrl: "https://example.test/v1",
          },
        },
      }),
      {},
    );

    await expect(client.healthCheck()).resolves.toEqual({
      ok: false,
      message: "analyzer,executor: OPENAI_API_KEY is not configured. | evaluator: OPENAI_API_KEY is not configured.",
    });
  });
});

function normalizeRequestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body === "string") {
    return JSON.parse(body);
  }
  throw new Error("Expected a JSON string body.");
}

function createSSEStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      controller.close();
    },
  });
}
