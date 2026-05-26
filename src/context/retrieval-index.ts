import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactStore } from "../memory/artifact-store.js";
import {
  RetrievedContextChunkSchema,
  type RetrievedContextChunk,
} from "../schemas.js";
import { dedupeAndRankRetrievedChunks } from "./ranking.js";

interface IndexedFileRecord {
  mtimeMs: number;
  size: number;
  chunkIds: string[];
}

interface IndexedChunkRecord {
  chunkId: string;
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  text: string;
  tokens: string[];
  vector: Record<string, number>;
}

interface WorkspaceIndexRecord {
  version: number;
  workspaceId: string;
  workspaceRoot: string;
  updatedAt: string;
  fullScanCompleted: boolean;
  files: Record<string, IndexedFileRecord>;
  chunks: IndexedChunkRecord[];
}

const INDEX_VERSION = 1;
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".swift",
  ".kt",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "dist",
  "build",
  ".little-helper",
]);

export class RetrievalIndex {
  public constructor(private readonly indexRoot: string) {}

  public static fromArtifactStore(
    artifactStore: ArtifactStore,
  ): RetrievalIndex {
    return new RetrievalIndex(
      path.join(path.dirname(artifactStore.runDirectory), "editor-index"),
    );
  }

  public async updateFromFiles(input: {
    workspaceId: string;
    workspaceRoot: string;
    filePaths: string[];
    ensureWorkspaceScan?: boolean;
  }): Promise<void> {
    await mkdir(this.indexRoot, { recursive: true });
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const index = await this.loadIndex(input.workspaceId, workspaceRoot);
    const candidateFiles = new Set<string>();

    for (const filePath of input.filePaths) {
      const resolved = resolveWorkspaceFile(workspaceRoot, filePath);
      if (resolved) {
        candidateFiles.add(resolved);
      }
    }

    if (input.ensureWorkspaceScan && !index.fullScanCompleted) {
      for (const filePath of await listWorkspaceSourceFiles(workspaceRoot)) {
        candidateFiles.add(filePath);
      }
      index.fullScanCompleted = true;
    }

    for (const filePath of candidateFiles) {
      await this.updateSingleFile(index, workspaceRoot, filePath);
    }

    index.updatedAt = new Date().toISOString();
    await this.saveIndex(input.workspaceId, index);
  }

  public async search(input: {
    workspaceId: string;
    workspaceRoot: string;
    query: string;
    activeFile?: string;
    relatedFiles?: string[];
    maxResults: number;
  }): Promise<RetrievedContextChunk[]> {
    const workspaceRoot = path.resolve(input.workspaceRoot);
    await this.updateFromFiles({
      workspaceId: input.workspaceId,
      workspaceRoot,
      filePaths: [
        ...(input.activeFile ? [input.activeFile] : []),
        ...(input.relatedFiles ?? []),
      ],
      ensureWorkspaceScan: true,
    });
    const index = await this.loadIndex(input.workspaceId, workspaceRoot);
    const queryTerms = normalizeTokens(input.query);
    const queryVector = buildVector(queryTerms);
    const activeFile = input.activeFile
      ? resolveWorkspaceFile(workspaceRoot, input.activeFile)
      : undefined;

    const candidates = index.chunks
      .filter((chunk) => chunk.filePath !== activeFile)
      .map((chunk) => scoreChunk(chunk, queryTerms, queryVector, input))
      .filter((chunk): chunk is RetrievedContextChunk => chunk !== undefined);

    return dedupeAndRankRetrievedChunks(candidates, {
      maxResults: input.maxResults,
    });
  }

  private async updateSingleFile(
    index: WorkspaceIndexRecord,
    workspaceRoot: string,
    filePath: string,
  ): Promise<void> {
    const relativePath = path.relative(workspaceRoot, filePath);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        this.removeFile(index, relativePath);
        return;
      }
      const previous = index.files[relativePath];
      if (
        previous &&
        previous.mtimeMs === info.mtimeMs &&
        previous.size === info.size
      ) {
        return;
      }
      const content = await readFile(filePath, "utf8");
      const chunks = chunkSourceFile(filePath, relativePath, content);
      this.removeFile(index, relativePath);
      index.files[relativePath] = {
        mtimeMs: info.mtimeMs,
        size: info.size,
        chunkIds: chunks.map((chunk) => chunk.chunkId),
      };
      index.chunks.push(...chunks);
    } catch {
      this.removeFile(index, relativePath);
    }
  }

  private removeFile(index: WorkspaceIndexRecord, relativePath: string): void {
    const existing = index.files[relativePath];
    if (!existing) {
      return;
    }
    const chunkIds = new Set(existing.chunkIds);
    index.chunks = index.chunks.filter((chunk) => !chunkIds.has(chunk.chunkId));
    delete index.files[relativePath];
  }

  private async loadIndex(
    workspaceId: string,
    workspaceRoot: string,
  ): Promise<WorkspaceIndexRecord> {
    try {
      const raw = await readFile(this.resolveIndexPath(workspaceId), "utf8");
      const parsed = JSON.parse(raw) as WorkspaceIndexRecord;
      if (
        parsed.version !== INDEX_VERSION ||
        parsed.workspaceRoot !== workspaceRoot
      ) {
        return createEmptyIndex(workspaceId, workspaceRoot);
      }
      return parsed;
    } catch {
      return createEmptyIndex(workspaceId, workspaceRoot);
    }
  }

  private async saveIndex(
    workspaceId: string,
    value: WorkspaceIndexRecord,
  ): Promise<void> {
    await writeFile(
      this.resolveIndexPath(workspaceId),
      JSON.stringify(value, null, 2),
      "utf8",
    );
  }

  private resolveIndexPath(workspaceId: string): string {
    const fileName = `${createHash("sha1").update(workspaceId).digest("hex")}.json`;
    return path.join(this.indexRoot, fileName);
  }
}

function createEmptyIndex(
  workspaceId: string,
  workspaceRoot: string,
): WorkspaceIndexRecord {
  return {
    version: INDEX_VERSION,
    workspaceId,
    workspaceRoot,
    updatedAt: new Date(0).toISOString(),
    fullScanCompleted: false,
    files: {},
    chunks: [],
  };
}

function resolveWorkspaceFile(
  workspaceRoot: string,
  filePath: string,
): string | undefined {
  const resolved = path.resolve(workspaceRoot, filePath);
  const relativePath = path.relative(workspaceRoot, resolved);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return resolved;
}

async function listWorkspaceSourceFiles(
  workspaceRoot: string,
): Promise<string[]> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(workspaceRoot, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        results.push(...(await listWorkspaceSourceFiles(absolutePath)));
      }
      continue;
    }
    if (
      entry.isFile() &&
      SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      results.push(absolutePath);
    }
  }
  return results;
}

function chunkSourceFile(
  filePath: string,
  relativePath: string,
  content: string,
): IndexedChunkRecord[] {
  const lines = content.split("\n");
  const chunks: Array<{ startLine: number; endLine: number; symbol?: string }> =
    [];
  const symbols = findSymbolBoundaries(lines);

  if (symbols.length > 0) {
    for (let index = 0; index < symbols.length; index += 1) {
      const current = symbols[index]!;
      const nextStart = symbols[index + 1]?.line ?? lines.length + 1;
      chunks.push({
        startLine: current.line,
        endLine: Math.min(lines.length, Math.max(current.line, nextStart - 1)),
        symbol: current.symbol,
      });
    }
  } else {
    for (let startLine = 1; startLine <= lines.length; startLine += 30) {
      chunks.push({
        startLine,
        endLine: Math.min(lines.length, startLine + 39),
      });
    }
  }

  return chunks
    .map(({ startLine, endLine, symbol }) => {
      const text = lines
        .slice(startLine - 1, endLine)
        .join("\n")
        .trim();
      if (text.length === 0) {
        return undefined;
      }
      const pathTerms = normalizeTokens(relativePath.replaceAll(path.sep, " "));
      const symbolTerms = normalizeTokens(symbol ?? "");
      const contentTerms = normalizeTokens(text);
      const tokens = [
        ...new Set([...pathTerms, ...symbolTerms, ...contentTerms]),
      ];
      return {
        chunkId: createHash("sha1")
          .update(`${relativePath}:${startLine}:${endLine}:${symbol ?? ""}`)
          .digest("hex"),
        filePath,
        relativePath,
        startLine,
        endLine,
        ...(symbol ? { symbol } : {}),
        text,
        tokens,
        vector: buildVector(tokens),
      } satisfies IndexedChunkRecord;
    })
    .filter((chunk): chunk is IndexedChunkRecord => chunk !== undefined);
}

function findSymbolBoundaries(
  lines: string[],
): Array<{ line: number; symbol: string }> {
  const results: Array<{ line: number; symbol: string }> = [];
  const symbolPatterns = [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/,
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const pattern of symbolPatterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        results.push({ line: index + 1, symbol: match[1] });
        break;
      }
    }
  }
  return results;
}

function scoreChunk(
  chunk: IndexedChunkRecord,
  queryTerms: string[],
  queryVector: Record<string, number>,
  input: {
    workspaceId: string;
    query: string;
  },
): RetrievedContextChunk | undefined {
  if (queryTerms.length === 0) {
    return undefined;
  }

  const lowerText = chunk.text.toLowerCase();
  const lowerPath = chunk.relativePath.toLowerCase();
  const lowerSymbol = chunk.symbol?.toLowerCase();
  const normalizedQuery = input.query.trim().toLowerCase();
  const direct =
    normalizedQuery.length >= 3 && lowerText.includes(normalizedQuery) ? 1 : 0;
  const symbolMatches = lowerSymbol
    ? queryTerms.filter((term) => lowerSymbol.includes(term))
    : [];
  const pathMatches = queryTerms.filter((term) => lowerPath.includes(term));
  const lexicalMatches = queryTerms.filter((term) =>
    chunk.tokens.includes(term),
  );
  const semantic = cosineSimilarity(queryVector, chunk.vector);
  const symbol = symbolMatches.length / queryTerms.length;
  const pathScore = pathMatches.length / queryTerms.length;
  const lexical = lexicalMatches.length / queryTerms.length;
  const total =
    direct * 5 + symbol * 3 + pathScore * 2 + lexical * 1.5 + semantic;

  if (total < 0.4) {
    return undefined;
  }

  const provenanceKind =
    direct > 0
      ? "direct_hit"
      : symbol >= pathScore && symbol >= semantic
        ? "symbol_hit"
        : pathScore >= semantic
          ? "path_hit"
          : "semantic_hit";
  return RetrievedContextChunkSchema.parse({
    chunkId: chunk.chunkId,
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    ...(chunk.symbol ? { symbol: chunk.symbol } : {}),
    excerpt: chunk.text,
    scores: {
      direct,
      symbol,
      path: pathScore,
      lexical,
      semantic,
      total,
    },
    provenance: {
      kind: provenanceKind,
      workspaceId: input.workspaceId,
      query: input.query,
      matchedTerms: [
        ...new Set([...symbolMatches, ...pathMatches, ...lexicalMatches]),
      ],
      ...(chunk.symbol && symbolMatches.length > 0
        ? { matchedSymbol: chunk.symbol }
        : {}),
      ...(pathMatches.length > 0 ? { matchedPath: chunk.relativePath } : {}),
    },
  });
}

function normalizeTokens(value: string): string[] {
  return [...value.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)]
    .map((match) => match[0].toLowerCase())
    .flatMap(splitIdentifier)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

function buildVector(tokens: string[]): Record<string, number> {
  const vector: Record<string, number> = {};
  for (const token of tokens) {
    vector[token] = (vector[token] ?? 0) + 1;
  }
  return vector;
}

function cosineSimilarity(
  left: Record<string, number>,
  right: Record<string, number>,
): number {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const key of keys) {
    const leftValue = left[key] ?? 0;
    const rightValue = right[key] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "const",
  "function",
  "class",
  "type",
  "return",
  "export",
  "import",
  "default",
]);
