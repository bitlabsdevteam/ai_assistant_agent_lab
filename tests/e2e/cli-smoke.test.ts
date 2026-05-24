import { describe, expect, it } from "vitest";

import { createLLMClient } from "../../src/llm/providers.js";

describe("cli smoke prerequisites", () => {
  it("has a functioning mock llm provider for offline runs", async () => {
    const client = createLLMClient({
      env: "development",
      logLevel: "info",
      artifactDir: ".little-helper/runs",
      llmProvider: "mock",
      llmModel: "mock-default",
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
      ok: true,
      message: "Mock LLM provider is ready.",
    });
  });
});
