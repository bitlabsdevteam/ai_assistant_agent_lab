import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactStore } from "../../src/memory/artifact-store.js";
import { PermissionPolicy } from "../../src/policy/permissions.js";
import type { Settings } from "../../src/schemas.js";
import { FileSystemWriteTool, PatchTool } from "../../src/tools/filesystem.js";

function createSettings(workspace: string): Settings {
  return {
    env: "development",
    logLevel: "info",
    artifactDir: path.join(workspace, ".runs"),
    llmProvider: "mock",
    llmModel: "mock-default",
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
    mcpServers: [],
  };
}

describe("filesystem edit tools", () => {
  it("writes diff and backup artifacts for file mutations", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-fs-"));
    const target = path.join(workspace, "file.txt");
    await writeFile(target, "before", "utf8");
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();

    const tool = new FileSystemWriteTool();
    const result = await tool.run(
      {
        path: "file.txt",
        content: "after",
        createDirectories: true,
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["workspace"],
        signal: AbortSignal.timeout(5_000),
        settings,
        artifactStore,
        policy: new PermissionPolicy(settings),
        approvals: [],
      },
    );

    expect(result.changed).toBe(true);
    expect(result.existedBefore).toBe(true);
    expect(result.diffArtifact).toBeDefined();
    expect(result.backupArtifact).toBeDefined();
    expect(await readFile(target, "utf8")).toBe("after");
  });

  it("refuses to overwrite a git-modified tracked file", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-git-"));
    execFileSync("git", ["init"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
    await writeFile(path.join(workspace, "tracked.txt"), "initial", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "init"], { cwd: workspace });
    await writeFile(path.join(workspace, "tracked.txt"), "user edits", "utf8");

    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();
    const tool = new FileSystemWriteTool();

    await expect(
      tool.run(
        {
          path: "tracked.txt",
          content: "agent overwrite",
          createDirectories: true,
        },
        {
          runId: "run-1",
          workingDirectory: workspace,
          dryRun: false,
          permissions: ["workspace"],
          signal: AbortSignal.timeout(5_000),
          settings,
          artifactStore,
          policy: new PermissionPolicy(settings),
          approvals: [],
        },
      ),
    ).rejects.toThrow(/Refusing to rewrite user-modified tracked file inside git workspace/);
  });

  it("allows overwriting a clean tracked file while still recording diff artifacts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-git-clean-"));
    execFileSync("git", ["init"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
    await writeFile(path.join(workspace, "tracked.txt"), "initial", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "init"], { cwd: workspace });

    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();
    const tool = new FileSystemWriteTool();

    const result = await tool.run(
      {
        path: "tracked.txt",
        content: "agent rewrite",
        createDirectories: true,
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["workspace"],
        signal: AbortSignal.timeout(5_000),
        settings,
        artifactStore,
        policy: new PermissionPolicy(settings),
        approvals: [],
      },
    );

    expect(result.changed).toBe(true);
    expect(result.existedBefore).toBe(true);
    expect(result.diffArtifact).toBeDefined();
    expect(result.backupArtifact).toBeDefined();
    expect(await readFile(path.join(workspace, "tracked.txt"), "utf8")).toBe("agent rewrite");
  });

  it("writes patch artifacts for scoped patch edits", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-patch-"));
    await writeFile(path.join(workspace, "file.txt"), "hello old", "utf8");
    const settings = createSettings(workspace);
    const artifactStore = new ArtifactStore(settings.artifactDir, "run-1");
    await artifactStore.init();
    const tool = new PatchTool();

    const result = await tool.run(
      {
        path: "file.txt",
        find: "old",
        replace: "new",
      },
      {
        runId: "run-1",
        workingDirectory: workspace,
        dryRun: false,
        permissions: ["workspace"],
        signal: AbortSignal.timeout(5_000),
        settings,
        artifactStore,
        policy: new PermissionPolicy(settings),
        approvals: [],
      },
    );

    expect(result.changed).toBe(true);
    expect(result.diffArtifact).toBeDefined();
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("hello new");
  });
});
