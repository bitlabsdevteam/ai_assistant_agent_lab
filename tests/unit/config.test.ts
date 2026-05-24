import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config.js";
import { AppError } from "../../src/errors.js";

const testEnvWithApproval: NodeJS.ProcessEnv = {
  LITTLE_HELPER_APPROVAL_MODE: "on-risk",
};

const testProdEnv: NodeJS.ProcessEnv = {
  LITTLE_HELPER_ENV: "production",
  LITTLE_HELPER_LLM_PROVIDER: "mock",
};

const testProdOpenAIEnvMissingKey: NodeJS.ProcessEnv = {
  LITTLE_HELPER_ENV: "production",
  LITTLE_HELPER_LLM_PROVIDER: "openai",
  LITTLE_HELPER_LLM_MODEL: "gpt-4.1-mini",
};

describe("loadSettings", () => {
  it("applies project config, env, and cli override precedence", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-config-"));
    await writeFile(
      path.join(workspace, ".little-helper.config.json"),
      JSON.stringify({
        maxIterations: 2,
        approvalMode: "never",
        llmRouting: {
          evaluator: {
            provider: "openai",
            model: "gpt-4.1-mini",
            baseUrl: "https://example.test/v1",
          },
        },
      }),
      "utf8",
    );

    const settings = await loadSettings(
      workspace,
      { maxIterations: 5, outputFormat: "json" },
      testEnvWithApproval,
    );

    expect(settings.maxIterations).toBe(5);
    expect(settings.approvalMode).toBe("on-risk");
    expect(settings.outputFormat).toBe("json");
    expect(settings.allowedRoots).toContain(workspace);
    expect(settings.llmRouting.evaluator?.provider).toBe("openai");
    expect(settings.llmRouting.evaluator?.model).toBe("gpt-4.1-mini");
  });

  it("rejects unsafe production defaults", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-prod-"));

    await expect(
      loadSettings(
        workspace,
        {},
        testProdEnv,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("requires OPENAI_API_KEY for production openai settings", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-prod-openai-"));

    await expect(
      loadSettings(
        workspace,
        {},
        testProdOpenAIEnvMissingKey,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects production mock role overrides even when global provider is real", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-prod-routing-"));
    await writeFile(
      path.join(workspace, ".little-helper.config.json"),
      JSON.stringify({
        llmProvider: "openai",
        llmModel: "gpt-4.1-mini",
        llmRouting: {
          evaluator: {
            provider: "mock",
            model: "mock-default",
          },
        },
      }),
      "utf8",
    );

    await expect(
      loadSettings(
        workspace,
        {},
        {
          LITTLE_HELPER_ENV: "production",
          OPENAI_API_KEY: "test-key",
        },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
