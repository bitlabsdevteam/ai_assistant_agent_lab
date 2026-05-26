import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLLMClient } from "../../src/llm/providers.js";
import { buildAnalyzerPromptEnvelope } from "../../src/llm/prompts.js";
import type { Settings } from "../../src/schemas.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: ".little-helper/runs",
    llmProvider: "openai",
    llmModel: "gpt-5.4",
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
    skillDirectories: {
      project: [path.join(process.cwd(), ".little-helper", "skills")],
      user: [path.join(process.cwd(), ".user-skills")],
    },
    contextCompactionThresholdPercent: 70,
    llmContextWindows: {},
    mcpServers: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("multi-provider llm adapters", () => {
  it("routes health checks across unique configured providers", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("anthropic.test")) {
        return Promise.resolve(new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 }));
      }
      if (url.includes("gemini.test")) {
        return Promise.resolve(new Response(JSON.stringify({ name: "models/gemini-2.5-pro" }), { status: 200 }));
      }
      if (url.includes("moonshot.test")) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "kimi-k2" }] }), { status: 200 }));
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(
      createSettings({
        llmProvider: "anthropic",
        llmModel: "claude-3-7-sonnet-latest",
        llmBaseUrl: "https://anthropic.test/v1",
        llmRouting: {
          executor: {
            provider: "gemini",
            model: "gemini-2.5-pro",
            baseUrl: "https://gemini.test/v1beta",
          },
          evaluator: {
            provider: "moonshot",
            model: "kimi-k2-0905-preview",
            baseUrl: "https://moonshot.test/v1",
          },
        },
      }),
      {
        ANTHROPIC_API_KEY: "anthropic-key",
        GEMINI_API_KEY: "gemini-key",
        MOONSHOT_API_KEY: "moonshot-key",
      },
    );

    await expect(client.healthCheck()).resolves.toEqual({
      ok: true,
      message:
        "analyzer: Anthropic provider is reachable for model 'claude-3-7-sonnet-latest'. | executor: Gemini provider is reachable for model 'gemini-2.5-pro'. | evaluator: Moonshot provider is reachable for model 'kimi-k2-0905-preview'.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses Anthropic tool-based structured outputs", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "claude-3-7-sonnet-latest",
        tool_choice: {
          type: "tool",
          name: "analyzer_response",
        },
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "claude-3-7-sonnet-latest",
            content: [
              {
                type: "tool_use",
                input: {
                  status: "ok",
                },
              },
            ],
            usage: {
              input_tokens: 123,
              output_tokens: 45,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(
      createSettings({
        llmProvider: "anthropic",
        llmModel: "claude-3-7-sonnet-latest",
        llmBaseUrl: "https://anthropic.test/v1",
      }),
      {
        ANTHROPIC_API_KEY: "anthropic-key",
      },
    );

    const response = await client.generateObject(
      {
        role: "analyzer",
        prompt: createAnalyzerPromptEnvelope("Check status"),
        input: {},
      },
      z.object({
        status: z.literal("ok"),
      }),
    );

    expect(response.object).toEqual({ status: "ok" });
    expect(response.model).toBe("claude-3-7-sonnet-latest");
  });

  it("uses Gemini responseSchema structured outputs", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        generationConfig?: {
          responseMimeType?: string;
          responseSchema?: Record<string, unknown>;
        };
      };
      expect(body.generationConfig?.responseMimeType).toBe("application/json");
      expect(body.generationConfig?.responseSchema).toMatchObject({
        title: "analyzer_response",
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ status: "ok" }) }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 4,
              totalTokenCount: 14,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(
      createSettings({
        llmProvider: "gemini",
        llmModel: "gemini-2.5-pro",
        llmBaseUrl: "https://gemini.test/v1beta",
      }),
      {
        GEMINI_API_KEY: "gemini-key",
      },
    );

    const response = await client.generateObject(
      {
        role: "analyzer",
        prompt: createAnalyzerPromptEnvelope("Check status"),
        input: {},
      },
      z.object({
        status: z.literal("ok"),
      }),
    );

    expect(response.object).toEqual({ status: "ok" });
    expect(response.totalTokens).toBe(14);
  });

  it("uses Moonshot json_schema structured outputs", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: {
          type?: string;
          json_schema?: {
            name?: string;
            schema?: Record<string, unknown>;
          };
        };
      };
      expect(body.response_format?.type).toBe("json_schema");
      expect(body.response_format?.json_schema?.name).toBe("analyzer_response");
      expect(body.response_format?.json_schema?.schema).toMatchObject({
        title: "analyzer_response",
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "kimi-k2-0905-preview",
            choices: [
              {
                message: {
                  content: JSON.stringify({ status: "ok" }),
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createLLMClient(
      createSettings({
        llmProvider: "moonshot",
        llmModel: "kimi-k2-0905-preview",
        llmBaseUrl: "https://moonshot.test/v1",
      }),
      {
        MOONSHOT_API_KEY: "moonshot-key",
      },
    );

    const response = await client.generateObject(
      {
        role: "analyzer",
        prompt: createAnalyzerPromptEnvelope("Check status"),
        input: {},
      },
      z.object({
        status: z.literal("ok"),
      }),
    );

    expect(response.object).toEqual({ status: "ok" });
    expect(response.model).toBe("kimi-k2-0905-preview");
  });
});

function createAnalyzerPromptEnvelope(task: string) {
  return buildAnalyzerPromptEnvelope(
    {
      task,
      workingDirectory: "/tmp/workspace",
      profile: "default",
      dryRun: false,
      maxIterations: 1,
      selectedSkills: [],
      metadata: {},
    },
    [
      {
        name: "fs.write",
        description: "Write files",
        sideEffecting: true,
        category: "edit",
      },
    ],
    undefined,
    {
      dryRun: false,
      permissions: ["workspace"],
      approvalMode: "on-risk",
    },
  );
}
