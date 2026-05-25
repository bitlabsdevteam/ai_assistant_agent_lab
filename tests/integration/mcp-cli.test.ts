import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("mcp cli", () => {
  it("adds an MCP server and exposes it through list and inspect", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-cli-"));
    const addResult = runCLI([
      "mcp",
      "add",
      "mock",
      "--cwd",
      workspace,
      "--output",
      "json",
      "--command",
      "node",
      "--arg",
      path.resolve("tests/fixtures/mock-mcp-server.mjs"),
    ]);

    expect(addResult.status).toBe(0);
    const added = JSON.parse(addResult.stdout) as {
      scope: string;
      configPath: string;
      discovery: { status: string; tools: Array<{ name: string }> };
    };
    expect(added.scope).toBe("project");
    expect(added.discovery.status).toBe("ready");
    expect(added.discovery.tools.map((tool) => tool.name)).toContain("echo");

    const config = JSON.parse(await readFile(path.join(workspace, ".little-helper.config.json"), "utf8")) as {
      mcpServers: Array<{ name: string }>;
    };
    expect(config.mcpServers.map((entry) => entry.name)).toEqual(["mock"]);

    const listResult = runCLI(["mcp", "list", "--cwd", workspace, "--output", "json"]);
    expect(listResult.status).toBe(0);
    const listed = JSON.parse(listResult.stdout) as Array<{ server: string; status: string }>;
    expect(listed).toEqual([
      expect.objectContaining({
        server: "mock",
        status: "ready",
      }),
    ]);

    const inspectResult = runCLI(["mcp", "inspect", "mock", "--cwd", workspace, "--output", "json"]);
    expect(inspectResult.status).toBe(0);
    const inspected = JSON.parse(inspectResult.stdout) as { server: string; tools: Array<{ name: string }> };
    expect(inspected.server).toBe("mock");
    expect(inspected.tools.map((tool) => tool.name)).toContain("echo");
  });

  it("returns non-zero and leaves config unchanged when add discovery fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-mcp-cli-fail-"));
    const configPath = path.join(workspace, ".little-helper.config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          artifactDir: ".runs",
        },
        null,
        2,
      ),
      "utf8",
    );

    const failure = runCLI([
      "mcp",
      "add",
      "broken",
      "--cwd",
      workspace,
      "--output",
      "json",
      "--command",
      "node",
      "--arg",
      path.join(workspace, "does-not-exist.mjs"),
    ]);

    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain("MCP discovery failed");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toEqual({
      artifactDir: ".runs",
    });
  });
});

function runCLI(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      LITTLE_HELPER_ENV: "test",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
