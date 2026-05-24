import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { AppError } from "../errors.js";
import { type ToolContext, buildDescriptor, type Tool } from "./base.js";

const execFileAsync = promisify(execFile);

const ReadFileInputSchema = z.object({
  path: z.string().min(1),
});
const ReadFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const ListFilesInputSchema = z.object({
  path: z.string().min(1).default("."),
  recursive: z.boolean().default(false),
});
const ListFilesOutputSchema = z.object({
  path: z.string(),
  files: z.array(z.string()),
});

const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirectories: z.boolean().default(true),
});
const WriteFileOutputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  changed: z.boolean(),
  existedBefore: z.boolean(),
  backupArtifact: z.string().optional(),
  diffArtifact: z.string().optional(),
});

const PatchFileInputSchema = z.object({
  path: z.string().min(1),
  find: z.string(),
  replace: z.string(),
});
const PatchFileOutputSchema = z.object({
  path: z.string(),
  changed: z.boolean(),
  backupArtifact: z.string().optional(),
  diffArtifact: z.string().optional(),
});

const SearchInputSchema = z.object({
  path: z.string().min(1).default("."),
  query: z.string().min(1),
});
const SearchOutputSchema = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      lineNumber: z.number().int().positive(),
      line: z.string(),
    }),
  ),
});

const DiffInputSchema = z.object({
  path: z.string().min(1),
  previousContent: z.string(),
});
const DiffOutputSchema = z.object({
  path: z.string(),
  changed: z.boolean(),
  diff: z.string(),
});

const GitOutputSchema = z.object({
  gitAvailable: z.boolean(),
  output: z.string(),
});

export class FileSystemReadTool implements Tool<typeof ReadFileInputSchema, typeof ReadFileOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "fs.read",
    description: "Read a text file from the workspace.",
    category: "read",
    riskLevel: "low",
    sideEffecting: false,
    permissionScope: "read-only",
  });
  public readonly inputSchema = ReadFileInputSchema;
  public readonly outputSchema = ReadFileOutputSchema;

  public validate(input: z.infer<typeof ReadFileInputSchema>, context: ToolContext): void {
    context.policy.ensurePathAllowed(resolveWorkspacePath(context, input.path));
  }

  public async run(input: z.infer<typeof ReadFileInputSchema>, context: ToolContext): Promise<z.infer<typeof ReadFileOutputSchema>> {
    const target = resolveWorkspacePath(context, input.path);
    const content = await readFile(target, "utf8");
    return { path: target, content };
  }
}

export class FileSystemListTool implements Tool<typeof ListFilesInputSchema, typeof ListFilesOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "fs.list",
    description: "List files from the workspace.",
    category: "search",
    riskLevel: "low",
    sideEffecting: false,
    permissionScope: "read-only",
  });
  public readonly inputSchema = ListFilesInputSchema;
  public readonly outputSchema = ListFilesOutputSchema;

  public validate(input: z.infer<typeof ListFilesInputSchema>, context: ToolContext): void {
    context.policy.ensurePathAllowed(resolveWorkspacePath(context, input.path));
  }

  public async run(input: z.infer<typeof ListFilesInputSchema>, context: ToolContext): Promise<z.infer<typeof ListFilesOutputSchema>> {
    const target = resolveWorkspacePath(context, input.path);
    const files = input.recursive ? await listRecursive(target) : await readdir(target);
    return { path: target, files };
  }
}

export class FileSystemWriteTool implements Tool<typeof WriteFileInputSchema, typeof WriteFileOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "fs.write",
    description: "Write a text file in the workspace.",
    category: "edit",
    riskLevel: "medium",
    sideEffecting: true,
    permissionScope: "workspace",
  });
  public readonly inputSchema = WriteFileInputSchema;
  public readonly outputSchema = WriteFileOutputSchema;

  public validate(input: z.infer<typeof WriteFileInputSchema>, context: ToolContext): void {
    context.policy.ensurePathAllowed(resolveWorkspacePath(context, input.path));
  }

  public async run(input: z.infer<typeof WriteFileInputSchema>, context: ToolContext): Promise<z.infer<typeof WriteFileOutputSchema>> {
    const target = resolveWorkspacePath(context, input.path);
    const existing = await readTextIfExists(target);
    const existedBefore = existing !== undefined;
    const changed = existing !== input.content;

    if (changed) {
      await ensureSafeGitMutation(target, existing, input.content, context, { allowTrackedPatch: false });
    }

    if (context.dryRun) {
      return {
        path: target,
        bytesWritten: Buffer.byteLength(input.content, "utf8"),
        changed,
        existedBefore,
      };
    }
    if (input.createDirectories) {
      await mkdir(path.dirname(target), { recursive: true });
    }
    let backupArtifact: string | undefined;
    let diffArtifact: string | undefined;
    if (changed && existing !== undefined) {
      backupArtifact = await context.artifactStore.writeArtifactJson(
        `backup-${sanitizeFileName(path.basename(target))}-${Date.now()}.json`,
        {
          path: target,
          content: existing,
        },
      );
      diffArtifact = await context.artifactStore.writeArtifactText(
        `diff-${sanitizeFileName(path.basename(target))}-${Date.now()}.patch`,
        buildSimpleDiff(existing, input.content),
      );
    } else if (changed) {
      diffArtifact = await context.artifactStore.writeArtifactText(
        `diff-${sanitizeFileName(path.basename(target))}-${Date.now()}.patch`,
        buildSimpleDiff("", input.content),
      );
    }
    if (changed) {
      await writeFile(target, input.content, "utf8");
    }
    return {
      path: target,
      bytesWritten: Buffer.byteLength(input.content, "utf8"),
      changed,
      existedBefore,
      ...(backupArtifact ? { backupArtifact } : {}),
      ...(diffArtifact ? { diffArtifact } : {}),
    };
  }
}

export class PatchTool implements Tool<typeof PatchFileInputSchema, typeof PatchFileOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "fs.patch",
    description: "Apply a simple string replacement patch to a workspace file.",
    category: "edit",
    riskLevel: "medium",
    sideEffecting: true,
    permissionScope: "workspace",
  });
  public readonly inputSchema = PatchFileInputSchema;
  public readonly outputSchema = PatchFileOutputSchema;

  public validate(input: z.infer<typeof PatchFileInputSchema>, context: ToolContext): void {
    context.policy.ensurePathAllowed(resolveWorkspacePath(context, input.path));
  }

  public async run(input: z.infer<typeof PatchFileInputSchema>, context: ToolContext): Promise<z.infer<typeof PatchFileOutputSchema>> {
    const target = resolveWorkspacePath(context, input.path);
    const current = await readFile(target, "utf8");
    const updated = current.replace(input.find, input.replace);
    const changed = updated !== current;
    if (changed) {
      await ensureSafeGitMutation(target, current, updated, context, { allowTrackedPatch: true });
    }
    let backupArtifact: string | undefined;
    let diffArtifact: string | undefined;
    if (changed && !context.dryRun) {
      backupArtifact = await context.artifactStore.writeArtifactJson(
        `backup-${sanitizeFileName(path.basename(target))}-${Date.now()}.json`,
        {
          path: target,
          content: current,
        },
      );
      diffArtifact = await context.artifactStore.writeArtifactText(
        `diff-${sanitizeFileName(path.basename(target))}-${Date.now()}.patch`,
        buildSimpleDiff(current, updated),
      );
      await writeFile(target, updated, "utf8");
    }
    return {
      path: target,
      changed,
      ...(backupArtifact ? { backupArtifact } : {}),
      ...(diffArtifact ? { diffArtifact } : {}),
    };
  }
}

export class SearchTool implements Tool<typeof SearchInputSchema, typeof SearchOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "fs.search",
    description: "Search text inside workspace files.",
    category: "search",
    riskLevel: "low",
    sideEffecting: false,
    permissionScope: "read-only",
  });
  public readonly inputSchema = SearchInputSchema;
  public readonly outputSchema = SearchOutputSchema;

  public validate(input: z.infer<typeof SearchInputSchema>, context: ToolContext): void {
    context.policy.ensurePathAllowed(resolveWorkspacePath(context, input.path));
  }

  public async run(input: z.infer<typeof SearchInputSchema>, context: ToolContext): Promise<z.infer<typeof SearchOutputSchema>> {
    const root = resolveWorkspacePath(context, input.path);
    const files = await listRecursive(root);
    const matches: z.infer<typeof SearchOutputSchema>["matches"] = [];

    for (const relative of files) {
      const absolute = path.join(root, relative);
      const fileStats = await stat(absolute);
      if (!fileStats.isFile()) {
        continue;
      }
      const content = await readFile(absolute, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (line.includes(input.query)) {
          matches.push({
            path: absolute,
            lineNumber: index + 1,
            line,
          });
        }
      });
    }

    return { matches };
  }
}

export class DiffTool implements Tool<typeof DiffInputSchema, typeof DiffOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "fs.diff",
    description: "Produce a simple diff against provided previous content.",
    category: "validation",
    riskLevel: "low",
    sideEffecting: false,
    permissionScope: "read-only",
  });
  public readonly inputSchema = DiffInputSchema;
  public readonly outputSchema = DiffOutputSchema;

  public validate(input: z.infer<typeof DiffInputSchema>, context: ToolContext): void {
    context.policy.ensurePathAllowed(resolveWorkspacePath(context, input.path));
  }

  public async run(input: z.infer<typeof DiffInputSchema>, context: ToolContext): Promise<z.infer<typeof DiffOutputSchema>> {
    const target = resolveWorkspacePath(context, input.path);
    const current = await readFile(target, "utf8");
    const changed = current !== input.previousContent;
    return {
      path: target,
      changed,
      diff: changed ? buildSimpleDiff(input.previousContent, current) : "",
    };
  }
}

export class GitReadTool implements Tool<typeof ReadFileInputSchema, typeof GitOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "git.inspect",
    description: "Inspect git metadata in read-only mode.",
    category: "read",
    riskLevel: "low",
    sideEffecting: false,
    permissionScope: "read-only",
  });
  public readonly inputSchema = ReadFileInputSchema;
  public readonly outputSchema = GitOutputSchema;

  public validate(): void {}

  public async run(_: z.infer<typeof ReadFileInputSchema>, context: ToolContext): Promise<z.infer<typeof GitOutputSchema>> {
    const gitDir = path.join(context.workingDirectory, ".git");
    try {
      await access(gitDir, fsConstants.R_OK);
      return {
        gitAvailable: true,
        output: "Git repository detected.",
      };
    } catch {
      return {
        gitAvailable: false,
        output: "No git repository detected.",
      };
    }
  }
}

function resolveWorkspacePath(context: ToolContext, targetPath: string): string {
  const resolved = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(context.workingDirectory, targetPath);
  context.policy.ensurePathAllowed(resolved);
  return resolved;
}

async function listRecursive(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute) || entry.name;
    if (entry.isDirectory()) {
      const nested = await listRecursive(root, absolute);
      results.push(...nested);
    } else {
      results.push(relative);
    }
  }
  return results;
}

function buildSimpleDiff(previousContent: string, currentContent: string): string {
  const previousLines = previousContent.split("\n");
  const currentLines = currentContent.split("\n");
  const max = Math.max(previousLines.length, currentLines.length);
  const chunks: string[] = [];
  for (let index = 0; index < max; index += 1) {
    const before = previousLines[index];
    const after = currentLines[index];
    if (before === after) {
      continue;
    }
    if (before !== undefined) {
      chunks.push(`- ${before}`);
    }
    if (after !== undefined) {
      chunks.push(`+ ${after}`);
    }
  }
  return chunks.join("\n");
}

async function readTextIfExists(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

async function ensureSafeGitMutation(
  target: string,
  current: string | undefined,
  next: string,
  context: ToolContext,
  options: {
    allowTrackedPatch: boolean;
  },
): Promise<void> {
  if (current === next) {
    return;
  }
  const repositoryRoot = await findGitRoot(context.workingDirectory);
  if (!repositoryRoot) {
    return;
  }
  const relativeTarget = path.relative(repositoryRoot, target);
  if (relativeTarget.startsWith("..")) {
    return;
  }

  if (options.allowTrackedPatch || current === undefined) {
    return;
  }

  const gitState = await inspectGitFileState(repositoryRoot, relativeTarget);
  if (gitState === "modified") {
    throw new AppError(
      "POLICY_ERROR",
      `Refusing to rewrite user-modified tracked file inside git workspace without a patch workflow: ${relativeTarget}`,
    );
  }
}

async function inspectGitFileState(
  repositoryRoot: string,
  relativeTarget: string,
): Promise<"tracked_clean" | "modified" | "untracked_or_missing"> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", relativeTarget], {
      cwd: repositoryRoot,
    });
  } catch {
    return "untracked_or_missing";
  }

  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", relativeTarget], {
      cwd: repositoryRoot,
    });
    return stdout.trim().length > 0 ? "modified" : "tracked_clean";
  } catch {
    return "tracked_clean";
  }
}

async function findGitRoot(startDirectory: string): Promise<string | undefined> {
  let current = path.resolve(startDirectory);
  while (true) {
    try {
      await access(path.join(current, ".git"), fsConstants.R_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

function sanitizeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9-_]+/g, "-");
}
