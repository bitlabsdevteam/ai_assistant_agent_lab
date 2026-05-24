import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLLMClient } from "../../src/llm/providers.js";
import { AnalysisResultSchema } from "../../src/schemas.js";
import type { Settings } from "../../src/schemas.js";

function createSettings(baseUrl: string, overrides: Partial<Settings> = {}): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: ".little-helper/runs",
    llmProvider: "openai",
    llmModel: "gpt-4.1-mini",
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAIResponsesClient", () => {
  it("performs a health check against the configured base URL", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(normalizeRequestUrl(input)).toBe("https://example.test/v1/models/gpt-4.1-mini");
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
      message: "OpenAI provider is reachable for model 'gpt-4.1-mini'.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests structured output and validates the JSON response", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonBody(init?.body) as {
        model: string;
        text?: { format?: { type?: string; schema?: Record<string, unknown> } };
      };
      expect(body.model).toBe("gpt-4.1-mini");
      expect(body.text?.format?.type).toBe("json_schema");
      expect(body.text?.format?.schema).toMatchObject({
        title: "analyzer_response",
        type: "object",
      });
      return Promise.resolve(new Response(
        JSON.stringify({
          model: "gpt-4.1-mini",
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

    expect(response.model).toBe("gpt-4.1-mini");
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

  it("reports missing OPENAI_API_KEY in health checks", async () => {
    const client = createLLMClient(createSettings("https://example.test/v1"), {});
    await expect(client.healthCheck()).resolves.toEqual({
      ok: false,
      message: "OPENAI_API_KEY is not configured.",
    });
  });

  it("routes roles to different providers when llmRouting overrides are configured", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = parseJsonBody(init?.body) as {
        text?: { format?: { name?: string } };
      };
      expect(body.text?.format?.name).toBe("evaluator_response");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "gpt-4.1-mini",
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
        llmProvider: "mock",
        llmModel: "mock-default",
        llmBaseUrl: undefined,
        llmOrganization: undefined,
        llmProject: undefined,
        llmRouting: {
          evaluator: {
            provider: "openai",
            model: "gpt-4.1-mini",
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
    expect(analysis.object.requiredTools).toEqual(["fs.list", "fs.write"]);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const evaluation = await client.generateObject(
      {
        role: "evaluator",
        prompt: "Evaluate this execution",
        input: {},
      },
      z.object({ verdict: z.string() }),
    );
    expect(evaluation.object).toEqual({ verdict: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports aggregated health for mixed role routes", async () => {
    const client = createLLMClient(
      createSettings("https://example.test/v1", {
        llmProvider: "mock",
        llmModel: "mock-default",
        llmRouting: {
          evaluator: {
            provider: "openai",
            model: "gpt-4.1-mini",
            baseUrl: "https://example.test/v1",
          },
        },
      }),
      {},
    );

    await expect(client.healthCheck()).resolves.toEqual({
      ok: false,
      message: "analyzer,executor: Mock LLM provider is ready. | evaluator: OPENAI_API_KEY is not configured.",
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
