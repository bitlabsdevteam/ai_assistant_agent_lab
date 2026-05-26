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
};

const testProdOpenAIEnvMissingKey: NodeJS.ProcessEnv = {
  LITTLE_HELPER_ENV: "production",
  LITTLE_HELPER_LLM_PROVIDER: "openai",
  LITTLE_HELPER_LLM_MODEL: "gpt-5.4",
};

const testProdAnthropicEnvMissingKey: NodeJS.ProcessEnv = {
  LITTLE_HELPER_ENV: "production",
  LITTLE_HELPER_LLM_PROVIDER: "anthropic",
  LITTLE_HELPER_LLM_MODEL: "claude-3-7-sonnet-latest",
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
            model: "gpt-5.4-mini",
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
    expect(settings.llmProvider).toBe("openai");
    expect(settings.llmModel).toBe("gpt-5.4");
    expect(settings.llmRouting.evaluator?.provider).toBe("openai");
    expect(settings.llmRouting.evaluator?.model).toBe("gpt-5.4-mini");
  });

  it("rejects production defaults without OPENAI_API_KEY", async () => {
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

  it("requires only the resolved provider credential set in production", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-prod-anthropic-"));

    await expect(loadSettings(workspace, {}, testProdAnthropicEnvMissingKey)).rejects.toBeInstanceOf(AppError);

    await expect(
      loadSettings(workspace, {}, {
        ...testProdAnthropicEnvMissingKey,
        ANTHROPIC_API_KEY: "test-key",
      }),
    ).resolves.toMatchObject({
      llmProvider: "anthropic",
      llmModel: "claude-3-7-sonnet-latest",
    });
  });

  it("loads environment settings and secrets from the workspace .env file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-dotenv-"));
    await writeFile(
      path.join(workspace, ".env"),
      ["OPENAI_API_KEY=test-key", "LITTLE_HELPER_LLM_MODEL=gpt-5.4-mini", "LITTLE_HELPER_APPROVAL_MODE=never"].join(
        "\n",
      ),
      "utf8",
    );

    await expect(
      loadSettings(
        workspace,
        {},
        {
          LITTLE_HELPER_ENV: "production",
        },
      ),
    ).resolves.toMatchObject({
      llmModel: "gpt-5.4-mini",
      approvalMode: "never",
    });
  });

  it("resolves default project and user skill directories", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-skill-config-"));
    const settings = await loadSettings(
      workspace,
      {},
      {
        HOME: path.join(workspace, "fake-home"),
      },
    );

    expect(settings.skillDirectories.project).toEqual([path.join(workspace, ".little-helper", "skills")]);
    expect(settings.skillDirectories.user).toEqual([path.join(workspace, "fake-home", ".config", "little-helper", "skills")]);
  });

  it("rejects unsupported provider role overrides even when global provider is OpenAI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-prod-routing-"));
    await writeFile(
      path.join(workspace, ".little-helper.config.json"),
      JSON.stringify({
        llmProvider: "openai",
        llmModel: "gpt-5.4",
        llmRouting: {
          evaluator: {
            provider: "legacy",
            model: "legacy-default",
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

  it("accepts all supported providers in global config and role overrides", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-multi-provider-"));
    await writeFile(
      path.join(workspace, ".little-helper.config.json"),
      JSON.stringify({
        llmProvider: "moonshot",
        llmModel: "kimi-k2-0905-preview",
        llmRouting: {
          analyzer: {
            provider: "openai",
            model: "gpt-5.4-mini",
          },
          executor: {
            provider: "anthropic",
            model: "claude-3-7-sonnet-latest",
          },
          evaluator: {
            provider: "gemini",
            model: "gemini-2.5-pro",
          },
        },
      }),
      "utf8",
    );

    await expect(loadSettings(workspace, {}, {})).resolves.toMatchObject({
      llmProvider: "moonshot",
      llmRouting: {
        analyzer: {
          provider: "openai",
        },
        executor: {
          provider: "anthropic",
        },
        evaluator: {
          provider: "gemini",
        },
      },
    });
  });
});
