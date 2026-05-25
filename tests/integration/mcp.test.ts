import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import type { Settings } from "../../src/schemas.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("mcp bridge", () => {
  it("discovers and invokes MCP tools through the registry", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-"));
    const artifactStore = new ArtifactStore(path.join(workspace, ".runs"), "run-1");
    await artifactStore.init();

    const settings: Settings = {
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
      networkAllowlist: [],
      skillDirectories: {
        project: [path.join(workspace, ".little-helper", "skills")],
        user: [path.join(workspace, ".user-skills")],
      },
      mcpServers: [
        {
          name: "mock",
          command: "node",
          args: [path.resolve("tests/fixtures/mock-mcp-server.mjs")],
          transport: "stdio",
          enabled: true,
          timeoutMs: 5_000,
          allowedTools: ["echo"],
        },
      ],
    };

    const registry = await ToolRegistry.create(settings);
    expect(registry.listMCPServers()).toHaveLength(1);
    expect(registry.getMCPServer("mock").tools.map((tool) => tool.name)).toContain("echo");

    const result = await registry.invoke(
      "mcp.mock.echo",
      { message: "hello" },
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["read-only"],
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
      server: "mock",
      tool: "echo",
      result: {
        echoed: {
          message: "hello",
        },
      },
    });
  });
});
