import { describe, expect, it } from "vitest";

import { createLLMClient } from "../../src/llm/providers.js";

describe("cli smoke prerequisites", () => {
  it("defaults to the OpenAI provider and reports missing credentials clearly", async () => {
    const client = createLLMClient({
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
      mcpServers: [],
    });

    await expect(client.healthCheck()).resolves.toEqual({
      ok: false,
      message: "OPENAI_API_KEY is not configured.",
    });
  });
});
