import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactStore } from "../memory/artifact-store.js";
import type {
  ContextSource,
  EditorContext,
  EditorDiagnostic,
  EditorLocation,
  RetrievedContextChunk,
  RunRequest,
} from "../schemas.js";
import { RetrievalIndex } from "./retrieval-index.js";

export interface ContextSectionDraft {
  id: string;
  label: string;
  trustLevel: "trusted" | "untrusted_context";
  fullText: string;
  compactText: string;
  aggressiveText: string;
  priority: number;
}

export interface ExpandedEditorContext {
  sections: ContextSectionDraft[];
  sources: ContextSource[];
  retrievedChunks: RetrievedContextChunk[];
}

export async function expandEditorContext(
  request: RunRequest,
  artifactStore: ArtifactStore,
): Promise<ExpandedEditorContext> {
  const editorContext = request.editorContext;
  if (!editorContext) {
    return {
      sections: [],
      sources: [],
      retrievedChunks: [],
    };
  }

  const workspaceRoot = path.resolve(request.workingDirectory);
  const activeFile = resolveWorkspacePath(
    workspaceRoot,
    editorContext.activeFile,
  );
  const visibleFiles = dedupeStrings([
    ...(activeFile ? [activeFile] : []),
    ...editorContext.openFiles
      .map((filePath) => resolveWorkspacePath(workspaceRoot, filePath))
      .filter(isDefined),
    ...editorContext.recentFiles
      .map((filePath) => resolveWorkspacePath(workspaceRoot, filePath))
      .filter(isDefined),
  ]);

  const activeContent = activeFile ? await safeReadFile(activeFile) : undefined;
  const selectionText = activeContent
    ? resolveSelectionText(activeContent, editorContext)
    : undefined;
  const activeSummary =
    activeFile && activeContent
      ? summarizeActiveFile(
          activeFile,
          workspaceRoot,
          activeContent,
          editorContext,
        )
      : undefined;
  const dependencySummaries =
    activeFile && activeContent
      ? await summarizeDependencies(activeFile, workspaceRoot, activeContent)
      : [];

  const sections: ContextSectionDraft[] = [];
  const sources: ContextSource[] = [
    {
      kind: "editor_context",
      label: "Editor context snapshot",
      trustLevel: "trusted",
      artifact: artifactStore.resolve("request.json"),
    },
  ];

  if (activeFile && activeContent) {
    sources.push({
      kind: "workspace_file",
      label: `Active file: ${path.relative(workspaceRoot, activeFile) || path.basename(activeFile)}`,
      artifact: activeFile,
      trustLevel: "trusted",
    });
  }

  if (selectionText || activeSummary || editorContext.diagnostics.length > 0) {
    const focusText = buildEditorFocusText({
      editorContext,
      workspaceRoot,
      ...(activeFile ? { activeFile } : {}),
      ...(selectionText ? { selectionText } : {}),
      ...(activeSummary ? { activeSummary } : {}),
    });
    if (focusText.trim().length > 0) {
      sections.push({
        id: "editor-focus",
        label: "Editor focus",
        trustLevel: "trusted",
        fullText: focusText,
        compactText: compactEditorFocusText({
          editorContext,
          workspaceRoot,
          ...(activeFile ? { activeFile } : {}),
          ...(selectionText ? { selectionText } : {}),
          ...(activeSummary ? { activeSummary } : {}),
        }),
        aggressiveText: [
          activeFile
            ? `Active file: ${path.relative(workspaceRoot, activeFile)}`
            : "Active file: none",
          selectionText
            ? `Selection: ${truncate(selectionText, 240)}`
            : "Selection: none",
          activeSummary?.enclosingSymbol
            ? `Enclosing symbol: ${activeSummary.enclosingSymbol}`
            : "",
        ]
          .filter((value) => value.length > 0)
          .join("\n"),
        priority: 2,
      });
    }
  }

  if (activeFile && activeContent) {
    const neighborhoodText = buildNeighborhoodText({
      workspaceRoot,
      activeFile,
      activeContent,
      ...(activeSummary ? { activeSummary } : {}),
      ...(selectionText ? { selectionText } : {}),
      dependencySummaries,
      editorContext,
    });
    sections.push({
      id: "local-code-neighborhood",
      label: "Local code neighborhood",
      trustLevel: "trusted",
      fullText: neighborhoodText,
      compactText: buildNeighborhoodCompactText({
        workspaceRoot,
        activeFile,
        ...(activeSummary ? { activeSummary } : {}),
        dependencySummaries,
      }),
      aggressiveText: buildNeighborhoodAggressiveText({
        workspaceRoot,
        activeFile,
        ...(activeSummary ? { activeSummary } : {}),
      }),
      priority: 3,
    });

    for (const dependency of dependencySummaries) {
      sources.push({
        kind: "workspace_file",
        label: `Related file: ${dependency.relativePath}`,
        artifact: dependency.filePath,
        trustLevel: "trusted",
      });
    }
  }

  const retrievedChunks = await retrieveWorkspaceContext({
    request,
    artifactStore,
    editorContext,
    workspaceRoot,
    ...(activeFile ? { activeFile } : {}),
    visibleFiles: [
      ...visibleFiles,
      ...dependencySummaries.map((dependency) => dependency.filePath),
    ],
    ...(activeSummary ? { activeSummary } : {}),
    ...(selectionText ? { selectionText } : {}),
  });

  if (retrievedChunks.length > 0) {
    sections.push({
      id: "retrieved-workspace-context",
      label: "Retrieved workspace context",
      trustLevel: "untrusted_context",
      fullText: renderRetrievedContext(retrievedChunks, workspaceRoot),
      compactText: renderRetrievedContext(
        retrievedChunks.slice(0, 2),
        workspaceRoot,
      ),
      aggressiveText: "",
      priority: 7,
    });
    for (const chunk of retrievedChunks) {
      sources.push({
        kind: "retrieved_chunk",
        label: `Retrieved chunk: ${path.relative(workspaceRoot, chunk.filePath)}:${chunk.startLine}-${chunk.endLine}`,
        artifact: chunk.filePath,
        trustLevel: "untrusted_context",
      });
    }
  }

  return {
    sections,
    sources,
    retrievedChunks,
  };
}

async function retrieveWorkspaceContext(input: {
  request: RunRequest;
  artifactStore: ArtifactStore;
  editorContext: EditorContext;
  workspaceRoot: string;
  activeFile?: string;
  visibleFiles: string[];
  activeSummary?: ActiveFileSummary;
  selectionText?: string;
}): Promise<RetrievedContextChunk[]> {
  if (input.editorContext.retrieval.enabled === false) {
    return [];
  }
  if (
    !shouldUseRetrieval(
      input.request.task,
      input.selectionText,
      input.activeSummary,
    )
  ) {
    return [];
  }

  const query = createRetrievalQuery(
    input.request.task,
    input.selectionText,
    input.activeSummary,
  );
  const index = RetrievalIndex.fromArtifactStore(input.artifactStore);
  await index.updateFromFiles({
    workspaceId: input.editorContext.workspaceId,
    workspaceRoot: input.workspaceRoot,
    filePaths: input.visibleFiles,
  });
  return index.search({
    workspaceId: input.editorContext.workspaceId,
    workspaceRoot: input.workspaceRoot,
    query,
    ...(input.activeFile ? { activeFile: input.activeFile } : {}),
    relatedFiles: input.visibleFiles,
    maxResults: input.editorContext.retrieval.maxChunks,
  });
}

function shouldUseRetrieval(
  task: string,
  selectionText: string | undefined,
  activeSummary?: ActiveFileSummary,
): boolean {
  const normalizedTask = task.toLowerCase();
  if (
    /\b(find|where|implement|usage|used|references?|related|callers?|interface|inherits|extends)\b/.test(
      normalizedTask,
    )
  ) {
    return true;
  }
  if (
    selectionText &&
    selectionText.length > 0 &&
    /\b(what else|similar|related|implementation)\b/.test(normalizedTask)
  ) {
    return true;
  }
  return Boolean(
    activeSummary?.enclosingSymbol &&
    /\b(symbol|type|function|class)\b/.test(normalizedTask),
  );
}

function createRetrievalQuery(
  task: string,
  selectionText: string | undefined,
  activeSummary?: ActiveFileSummary,
): string {
  return [
    task,
    selectionText ? truncate(selectionText, 240) : "",
    activeSummary?.enclosingSymbol ?? "",
  ]
    .filter((value) => value.trim().length > 0)
    .join("\n");
}

interface ActiveFileSummary {
  relativePath: string;
  imports: string[];
  exports: string[];
  symbols: string[];
  enclosingSymbol?: string;
  nearbyExcerpt: string;
}

function summarizeActiveFile(
  filePath: string,
  workspaceRoot: string,
  content: string,
  editorContext: EditorContext,
): ActiveFileSummary {
  const lines = content.split("\n");
  const symbolEntries = findSymbolEntries(lines);
  const imports = lines
    .filter((line) => /^\s*import\b/.test(line))
    .slice(0, 8)
    .map((line) => line.trim());
  const exports = lines
    .filter((line) => /^\s*export\b/.test(line))
    .slice(0, 8)
    .map((line) => line.trim());
  const symbols = symbolEntries.map((entry) => entry.symbol).slice(0, 10);
  const anchorLine =
    editorContext.selection?.start.line ??
    editorContext.visibleRanges[0]?.start.line ??
    editorContext.selection?.end.line ??
    1;
  const enclosingSymbol = symbolEntries
    .filter((entry) => entry.line <= anchorLine)
    .at(-1)?.symbol;
  return {
    relativePath: path.relative(workspaceRoot, filePath),
    imports,
    exports,
    symbols,
    ...(enclosingSymbol ? { enclosingSymbol } : {}),
    nearbyExcerpt: "",
  };
}

async function summarizeDependencies(
  activeFile: string,
  workspaceRoot: string,
  content: string,
): Promise<Array<{ filePath: string; relativePath: string; summary: string }>> {
  const results: Array<{
    filePath: string;
    relativePath: string;
    summary: string;
  }> = [];
  for (const specifier of extractRelativeImports(content).slice(0, 4)) {
    const resolved = await resolveImportSpecifier(activeFile, specifier);
    if (!resolved) {
      continue;
    }
    const dependencyContent = await safeReadFile(resolved);
    if (!dependencyContent) {
      continue;
    }
    const symbols = findSymbols(dependencyContent.split("\n")).slice(0, 6);
    results.push({
      filePath: resolved,
      relativePath: path.relative(workspaceRoot, resolved),
      summary: [
        `File: ${path.relative(workspaceRoot, resolved)}`,
        `Top symbols: ${symbols.join(", ") || "none"}`,
        `Exports: ${
          dependencyContent
            .split("\n")
            .filter((line) => /^\s*export\b/.test(line))
            .slice(0, 3)
            .map((line) => line.trim())
            .join(" | ") || "none"
        }`,
      ].join("\n"),
    });
  }
  return results;
}

function buildEditorFocusText(input: {
  editorContext: EditorContext;
  workspaceRoot: string;
  activeFile?: string;
  selectionText?: string;
  activeSummary?: ActiveFileSummary;
}): string {
  const diagnostics = renderDiagnostics(
    input.editorContext.diagnostics,
    input.workspaceRoot,
    input.activeFile,
  );
  return [
    `Workspace: ${input.editorContext.workspaceId}`,
    `Active file: ${input.activeFile ? path.relative(input.workspaceRoot, input.activeFile) : "none"}`,
    input.activeSummary?.enclosingSymbol
      ? `Enclosing symbol: ${input.activeSummary.enclosingSymbol}`
      : "",
    input.editorContext.snapshotVersion
      ? `Snapshot version: ${input.editorContext.snapshotVersion}`
      : "",
    input.editorContext.timestamp
      ? `Snapshot timestamp: ${input.editorContext.timestamp}`
      : "",
    `Visible ranges: ${formatRanges(input.editorContext.visibleRanges)}`,
    `Open files: ${input.editorContext.openFiles.join(", ") || "none"}`,
    `Recent files: ${input.editorContext.recentFiles.join(", ") || "none"}`,
    input.selectionText
      ? `Selection text:\n${indentBlock(truncate(input.selectionText, 1_600), "  ")}`
      : "Selection text: none",
    diagnostics,
  ]
    .filter((value) => value.trim().length > 0)
    .join("\n");
}

function compactEditorFocusText(input: {
  editorContext: EditorContext;
  workspaceRoot: string;
  activeFile?: string;
  selectionText?: string;
  activeSummary?: ActiveFileSummary;
}): string {
  return [
    `Active file: ${input.activeFile ? path.relative(input.workspaceRoot, input.activeFile) : "none"}`,
    input.activeSummary?.enclosingSymbol
      ? `Enclosing symbol: ${input.activeSummary.enclosingSymbol}`
      : "",
    input.selectionText
      ? `Selection: ${truncate(input.selectionText, 360)}`
      : "Selection: none",
    input.editorContext.diagnostics.length > 0
      ? `Diagnostics: ${truncate(input.editorContext.diagnostics.map((diagnostic) => diagnostic.message).join("; "), 220)}`
      : "Diagnostics: none",
  ]
    .filter((value) => value.length > 0)
    .join("\n");
}

function buildNeighborhoodText(input: {
  workspaceRoot: string;
  activeFile: string;
  activeContent: string;
  activeSummary?: ActiveFileSummary;
  selectionText?: string;
  dependencySummaries: Array<{
    filePath: string;
    relativePath: string;
    summary: string;
  }>;
  editorContext: EditorContext;
}): string {
  const nearbyExcerpt = renderNearbyExcerpt(
    input.activeContent,
    input.editorContext,
  );
  return [
    `File summary: ${input.activeSummary?.relativePath ?? path.relative(input.workspaceRoot, input.activeFile)}`,
    `Top symbols: ${input.activeSummary?.symbols.join(", ") || "none"}`,
    `Imports: ${input.activeSummary?.imports.join(" | ") || "none"}`,
    `Exports: ${input.activeSummary?.exports.join(" | ") || "none"}`,
    `Nearby lines:\n${indentBlock(nearbyExcerpt, "  ")}`,
    input.dependencySummaries.length > 0
      ? `Immediate dependencies:\n${indentBlock(input.dependencySummaries.map((dependency) => dependency.summary).join("\n\n"), "  ")}`
      : "Immediate dependencies: none",
  ].join("\n");
}

function buildNeighborhoodCompactText(input: {
  workspaceRoot: string;
  activeFile: string;
  activeSummary?: ActiveFileSummary;
  dependencySummaries: Array<{
    filePath: string;
    relativePath: string;
    summary: string;
  }>;
}): string {
  return [
    `File: ${input.activeSummary?.relativePath ?? path.relative(input.workspaceRoot, input.activeFile)}`,
    `Symbols: ${truncate(input.activeSummary?.symbols.join(", ") || "none", 220)}`,
    `Dependencies: ${truncate(input.dependencySummaries.map((dependency) => dependency.relativePath).join(", ") || "none", 220)}`,
  ].join("\n");
}

function buildNeighborhoodAggressiveText(input: {
  workspaceRoot: string;
  activeFile: string;
  activeSummary?: ActiveFileSummary;
}): string {
  return [
    `File: ${input.activeSummary?.relativePath ?? path.relative(input.workspaceRoot, input.activeFile)}`,
    `Symbols: ${truncate(input.activeSummary?.symbols.join(", ") || "none", 120)}`,
  ].join("\n");
}

function renderRetrievedContext(
  chunks: RetrievedContextChunk[],
  workspaceRoot: string,
): string {
  return chunks
    .map((chunk, index) =>
      [
        `Result ${index + 1}: ${path.relative(workspaceRoot, chunk.filePath)}:${chunk.startLine}-${chunk.endLine}`,
        chunk.symbol ? `Symbol: ${chunk.symbol}` : "",
        `Provenance: ${chunk.provenance.kind} (score=${chunk.scores.total.toFixed(2)})`,
        chunk.provenance.matchedTerms.length > 0
          ? `Matched terms: ${chunk.provenance.matchedTerms.join(", ")}`
          : "",
        `Excerpt:\n${indentBlock(truncate(chunk.excerpt, 800), "  ")}`,
      ]
        .filter((value) => value.length > 0)
        .join("\n"),
    )
    .join("\n\n");
}

function resolveSelectionText(
  content: string,
  editorContext: EditorContext,
): string | undefined {
  const selection = editorContext.selection;
  if (!selection) {
    return undefined;
  }
  if (selection.selectedText && selection.selectedText.trim().length > 0) {
    return selection.selectedText;
  }
  const start = resolveOffset(content, selection.start);
  const end = resolveOffset(content, selection.end);
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  return content.slice(start, end);
}

function resolveOffset(
  content: string,
  location: EditorLocation,
): number | undefined {
  if (location.offset !== undefined) {
    return location.offset;
  }
  if (location.line === undefined || location.column === undefined) {
    return undefined;
  }
  const lines = content.split("\n");
  const prefix = lines.slice(0, location.line - 1).join("\n");
  const prefixLength = prefix.length === 0 ? 0 : prefix.length + 1;
  return prefixLength + Math.max(0, location.column - 1);
}

function renderNearbyExcerpt(
  content: string,
  editorContext: EditorContext,
): string {
  const lines = content.split("\n");
  const anchorLine =
    editorContext.selection?.start.line ??
    editorContext.visibleRanges[0]?.start.line ??
    editorContext.selection?.end.line ??
    1;
  const startLine = Math.max(1, anchorLine - 10);
  const endLine = Math.min(lines.length, anchorLine + 12);
  return lines
    .slice(startLine - 1, endLine)
    .map(
      (line, index) =>
        `${String(startLine + index).padStart(4, " ")} | ${line}`,
    )
    .join("\n");
}

function renderDiagnostics(
  diagnostics: EditorDiagnostic[],
  workspaceRoot: string,
  activeFile?: string,
): string {
  if (diagnostics.length === 0) {
    return "Diagnostics: none";
  }
  const relevant = diagnostics
    .filter((diagnostic) => {
      if (!activeFile) {
        return true;
      }
      return (
        resolveWorkspacePath(workspaceRoot, diagnostic.filePath) === activeFile
      );
    })
    .slice(0, 6);
  if (relevant.length === 0) {
    return "Diagnostics: none";
  }
  return [
    "Diagnostics:",
    ...relevant.map((diagnostic) => {
      const range = diagnostic.range
        ? `${diagnostic.range.start.line ?? "?"}:${diagnostic.range.start.column ?? "?"}`
        : "unknown";
      return `- ${diagnostic.severity.toUpperCase()} ${range} ${diagnostic.message}`;
    }),
  ].join("\n");
}

function findSymbols(lines: string[]): string[] {
  return findSymbolEntries(lines).map((entry) => entry.symbol);
}

function findSymbolEntries(
  lines: string[],
): Array<{ line: number; symbol: string }> {
  const symbols: Array<{ line: number; symbol: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match =
      line.match(
        /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      ) ??
      line.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/) ??
      line.match(
        /^\s*export\s+(?:class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/,
      ) ??
      line.match(/^\s*(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/) ??
      line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (match?.[1]) {
      symbols.push({ line: index + 1, symbol: match[1] });
    }
  }
  return symbols;
}

function extractRelativeImports(content: string): string[] {
  return [...content.matchAll(/from\s+["'](\.[^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

async function resolveImportSpecifier(
  activeFile: string,
  specifier: string,
): Promise<string | undefined> {
  const base = path.resolve(path.dirname(activeFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];
  for (const candidate of candidates) {
    if (await safeReadFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveWorkspacePath(
  workspaceRoot: string,
  filePath: string | undefined,
): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

function formatRanges(ranges: EditorContext["visibleRanges"]): string {
  if (ranges.length === 0) {
    return "none";
  }
  return ranges
    .map((range) => {
      if (range.start.line !== undefined && range.end.line !== undefined) {
        return `${range.start.line}:${range.start.column ?? 1}-${range.end.line}:${range.end.column ?? 1}`;
      }
      return `${range.start.offset ?? "?"}-${range.end.offset ?? "?"}`;
    })
    .join(", ");
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 16))} [...trimmed...]`;
}

function indentBlock(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
