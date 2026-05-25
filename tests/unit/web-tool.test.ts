import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import { createApprovalInputDigest } from "../../src/policy/permissions.js";
import type { Settings } from "../../src/schemas.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function createSettings(workspace: string): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: path.join(workspace, ".runs"),
    llmProvider: "openai",
    llmModel: "gpt-5.4",
    llmRouting: {},
    maxIterations: 2,
    approvalMode: "on-risk",
    outputFormat: "json",
    stream: false,
    maxToolOutputChars: 8_000,
    commandTimeoutMs: 30_000,
    shellAllowlist: ["node", "pnpm", "git"],
    validationCommands: [],
    allowedRoots: [workspace],
    networkAllowlist: ["api.perplexity.ai"],
    mcpServers: [],
  };
}

function createSettingsWithNetworkDisabled(workspace: string): Settings {
  return {
    ...createSettings(workspace),
    networkAllowlist: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("web search tool", () => {
  it("registers a Perplexity-backed web search tool", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-web-tool-list-"));
    const registry = await ToolRegistry.create(createSettings(workspace));

    expect(registry.list().map((tool) => tool.descriptor.name)).toContain("web.search");
  });

  it("queries Perplexity using PERPLEXITY_API_KEY from the workspace .env file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-web-tool-"));
    await writeFile(path.join(workspace, ".env"), "PERPLEXITY_API_KEY=test-perplexity-key\n", "utf8");
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(normalizeRequestUrl(_input)).toBe("https://api.perplexity.ai/search");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer test-perplexity-key",
        "content-type": "application/json",
      });
      expect(parseJsonBody(init?.body)).toEqual({
        query: "latest TypeScript release",
        max_results: 3,
        search_domain_filter: ["typescriptlang.org"],
        search_recency_filter: "month",
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            search_id: "search-123",
            results: [
              {
                title: "TypeScript 5.9",
                url: "https://www.typescriptlang.org/",
                snippet: "TypeScript release notes.",
                date: "2026-05-01",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const registry = await ToolRegistry.create(settings);
    const result = await registry.invoke(
      "web.search",
      {
        query: "latest TypeScript release",
        maxResults: 3,
        searchDomainFilter: ["typescriptlang.org"],
        searchRecencyFilter: "month",
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["network"],
        signal: AbortSignal.timeout(5_000),
        settings,
        artifactStore,
        policy: new PermissionPolicy(settings),
        approvals: [],
      },
      artifactStore,
      new PermissionPolicy(settings),
    );

    expect(result.record.status).toBe("success");
    expect(result.result).toEqual({
      provider: "perplexity",
      query: "latest TypeScript release",
      searchId: "search-123",
      resultCount: 1,
      results: [
        {
          title: "TypeScript 5.9",
          url: "https://www.typescriptlang.org/",
          snippet: "TypeScript release notes.",
          date: "2026-05-01",
        },
      ],
    });
  });

  it("fails clearly when PERPLEXITY_API_KEY is unavailable", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-web-tool-missing-key-"));
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();
    const registry = await ToolRegistry.create(settings);

    const result = await registry.invoke(
      "web.search",
      {
        query: "what is new in node",
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["network"],
        signal: AbortSignal.timeout(5_000),
        settings,
        artifactStore,
        policy: new PermissionPolicy(settings),
        approvals: [],
      },
      artifactStore,
      new PermissionPolicy(settings),
    );

    expect(result.record.status).toBe("failed");
    expect(result.record.error).toMatch(/PERPLEXITY_API_KEY/i);
  });

  it("requests approval when web.search targets a non-allowlisted host", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-web-tool-approval-"));
    const settings = createSettingsWithNetworkDisabled(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();
    const registry = await ToolRegistry.create(settings);

    const result = await registry.invoke(
      "web.search",
      {
        query: "weather in Tokyo, Japan",
        maxResults: 3,
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["network"],
        signal: AbortSignal.timeout(5_000),
        settings,
        artifactStore,
        policy: new PermissionPolicy(settings),
        approvals: [],
      },
      artifactStore,
      new PermissionPolicy(settings),
    );

    expect(result.record.status).toBe("skipped");
    expect(result.record.error).toMatch(/requires approval/i);
    expect(result.approvalRequest).toBeDefined();
    expect(result.approvalRequest?.toolName).toBe("web.search");
  });

  it("allows an approved web.search request even when the host is not allowlisted", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-web-tool-approved-"));
    await writeFile(path.join(workspace, ".env"), "PERPLEXITY_API_KEY=test-perplexity-key\n", "utf8");
    const settings = createSettingsWithNetworkDisabled(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            search_id: "search-approved",
            results: [
              {
                title: "Tokyo Weather",
                url: "https://example.com/weather",
                snippet: "Sunny.",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      query: "weather in Tokyo, Japan",
      maxResults: 3,
    };
    const approvals = [
      {
        id: "approval-1",
        runId: "run-1",
        createdAt: new Date().toISOString(),
        status: "approved" as const,
        toolName: "web.search",
        reason: "Approved by user",
        riskLevel: "high" as const,
        actionSummary: "Allow web.search",
        inputDigest: createApprovalInputDigest(input),
        decisionAt: new Date().toISOString(),
      },
    ];

    const registry = await ToolRegistry.create(settings);
    const result = await registry.invoke(
      "web.search",
      input,
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["network"],
        signal: AbortSignal.timeout(5_000),
        settings,
        artifactStore,
        policy: new PermissionPolicy(settings),
        approvals,
      },
      artifactStore,
      new PermissionPolicy(settings),
    );

    expect(result.record.status).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
  throw new Error("Expected JSON string body.");
}
