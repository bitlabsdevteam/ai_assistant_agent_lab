import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config.js";
import { AppError } from "../../src/errors.js";
import { buildMCPServerConfig, normalizeMCPAddInput, parseMCPAddArgv } from "../../src/mcp/commands.js";
import { addMCPServerConfig, resolveMCPConfigPath } from "../../src/mcp/config-manager.js";
import type { MCPDiscovery, Settings } from "../../src/schemas.js";

describe("mcp config manager", () => {
  it("creates a missing project config file when adding an MCP server", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-project-"));
    const settings = await loadSettings(workspace, { outputFormat: "json" }, {});
    const server = buildMCPServerConfig(
      normalizeMCPAddInput({
        name: "mock",
        command: "node",
        args: ["tests/fixtures/mock-mcp-server.mjs"],
      }),
    );

    const result = await addMCPServerConfig(
      {
        workingDirectory: workspace,
        scope: "project",
        server,
        settings,
      },
      {
        discoverServer: async () => createReadyDiscovery(server),
      },
    );

    expect(result.configPath).toBe(path.join(workspace, ".little-helper.config.json"));
    const saved = JSON.parse(await readFile(result.configPath, "utf8")) as { mcpServers: Array<{ name: string }> };
    expect(saved.mcpServers.map((entry) => entry.name)).toEqual(["mock"]);
  });

  it("creates a missing user config directory and file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-user-workspace-"));
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-home-"));
    const settings = await loadSettings(workspace, { outputFormat: "json" }, {});
    const server = buildMCPServerConfig(
      normalizeMCPAddInput({
        name: "user-mock",
        command: "node",
        args: ["tests/fixtures/mock-mcp-server.mjs"],
        disabled: true,
      }),
    );

    const result = await addMCPServerConfig(
      {
        workingDirectory: workspace,
        scope: "user",
        server,
        settings,
      },
      {
        homeDirectory,
        discoverServer: async () => createReadyDiscovery(server),
      },
    );

    expect(result.configPath).toBe(resolveMCPConfigPath("user", workspace, homeDirectory));
    const saved = JSON.parse(await readFile(result.configPath, "utf8")) as { mcpServers: Array<{ name: string; enabled: boolean }> };
    expect(saved.mcpServers).toEqual([
      expect.objectContaining({
        name: "user-mock",
        enabled: false,
      }),
    ]);
  });

  it("rejects duplicate MCP names in the target config", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-duplicate-"));
    const configPath = path.join(workspace, ".little-helper.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: [
          {
            name: "mock",
            transport: "stdio",
            command: "node",
            args: ["tests/fixtures/mock-mcp-server.mjs"],
            enabled: true,
            timeoutMs: 30_000,
            allowedTools: [],
          },
        ],
      }),
      "utf8",
    );
    const settings = await loadSettings(workspace, { outputFormat: "json" }, {});

    await expect(
      addMCPServerConfig(
        {
          workingDirectory: workspace,
          scope: "project",
          server: buildMCPServerConfig(
            normalizeMCPAddInput({
              name: "mock",
              command: "node",
              args: ["tests/fixtures/mock-mcp-server.mjs"],
            }),
          ),
          settings,
        },
        {
          discoverServer: async () => {
            throw new Error("discovery should not run for duplicates");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    } satisfies Partial<AppError>);
  });

  it("rejects invalid transport and flag combinations", () => {
    expect(() =>
      normalizeMCPAddInput({
        name: "missing-command",
        transport: "stdio",
      }),
    ).toThrow(/require `--command <cmd>`/);

    expect(() =>
      normalizeMCPAddInput({
        name: "missing-url",
        transport: "http",
      }),
    ).toThrow(/require `--url <url>`/);

    expect(() => parseMCPAddArgv(["mock", "--transport", "ftp"])).toThrow(/Unsupported MCP transport/);
  });

  it("rejects sse transport in mcp add input", () => {
    expect(() =>
      normalizeMCPAddInput({
        name: "mock",
        transport: "sse",
      }),
    ).toThrow(/not supported by `mcp add` yet/);
  });

  it("does not modify config when discovery fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-failed-discovery-"));
    const configPath = path.join(workspace, ".little-helper.config.json");
    const original = {
      artifactDir: ".runs",
      custom: {
        preserved: true,
      },
    };
    await writeFile(configPath, JSON.stringify(original, null, 2), "utf8");
    const settings = await loadSettings(workspace, { outputFormat: "json" }, {});
    const server = buildMCPServerConfig(
      normalizeMCPAddInput({
        name: "broken",
        command: "node",
        args: ["tests/fixtures/does-not-exist.mjs"],
      }),
    );

    await expect(
      addMCPServerConfig(
        {
          workingDirectory: workspace,
          scope: "project",
          server,
          settings,
        },
        {
          discoverServer: async () => ({
            ...createReadyDiscovery(server),
            status: "failed",
            error: "boom",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "TOOL_ERROR",
    } satisfies Partial<AppError>);

    const current = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(current).toEqual(original);
  });

  it("preserves unrelated config keys when writing", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-preserve-"));
    const configPath = path.join(workspace, ".little-helper.config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          artifactDir: ".custom-runs",
          networkAllowlist: ["example.com"],
        },
        null,
        2,
      ),
      "utf8",
    );
    const settings = await loadSettings(workspace, { outputFormat: "json" }, {});
    const server = buildMCPServerConfig(
      normalizeMCPAddInput({
        name: "mock",
        command: "node",
        args: ["tests/fixtures/mock-mcp-server.mjs"],
      }),
    );

    await addMCPServerConfig(
      {
        workingDirectory: workspace,
        scope: "project",
        server,
        settings,
      },
      {
        discoverServer: async () => createReadyDiscovery(server),
      },
    );

    const current = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(current).toMatchObject({
      artifactDir: ".custom-runs",
      networkAllowlist: ["example.com"],
    });
    expect((current.mcpServers as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["mock"]);
  });

  it("merges project and user MCP servers when loading settings", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-merge-workspace-"));
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-merge-home-"));
    await writeFile(
      path.join(workspace, ".little-helper.config.json"),
      JSON.stringify({
        mcpServers: [
          {
            name: "project-server",
            transport: "stdio",
            command: "node",
            args: ["project.mjs"],
            enabled: true,
            timeoutMs: 30_000,
            allowedTools: [],
          },
        ],
      }),
      "utf8",
    );
    const userConfigPath = path.join(homeDirectory, ".config", "little-helper", "config.json");
    await mkdir(path.dirname(userConfigPath), { recursive: true });
    await writeFile(
      userConfigPath,
      JSON.stringify({
        mcpServers: [
          {
            name: "user-server",
            transport: "http",
            url: "https://example.test/mcp",
            enabled: true,
            timeoutMs: 30_000,
            allowedTools: [],
          },
          {
            name: "project-server",
            transport: "http",
            url: "https://example.test/override",
            enabled: true,
            timeoutMs: 30_000,
            allowedTools: [],
          },
        ],
      }),
      "utf8",
    );

    const settings = await loadSettings(
      workspace,
      { outputFormat: "json" },
      {
        HOME: homeDirectory,
      },
    );

    expect(settings.mcpServers).toHaveLength(2);
    expect(settings.mcpServers.find((server) => server.name === "user-server")?.transport).toBe("http");
    expect(settings.mcpServers.find((server) => server.name === "project-server")?.url).toBe(
      "https://example.test/override",
    );
  });
});

function createReadyDiscovery(server: Settings["mcpServers"][number]): MCPDiscovery {
  return {
    server: server.name,
    transport: server.transport,
    status: "ready",
    tools: [
      {
        name: "echo",
        description: "Echo back input.",
        riskLevel: "low",
        sideEffecting: false,
        requiresApproval: false,
        permissionScope: "read-only",
      },
    ],
    resources: [],
    resourceTemplates: [],
  };
}
