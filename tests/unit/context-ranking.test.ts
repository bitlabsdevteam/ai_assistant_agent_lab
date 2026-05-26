import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  rankContextCandidates,
  dedupeAndRankRetrievedChunks,
} from "../../src/context/ranking.js";
import { RetrievalIndex } from "../../src/context/retrieval-index.js";

describe("context ranking", () => {
  it("ranks direct selection ahead of retrieved context", () => {
    const ranked = rankContextCandidates([
      { id: "retrieved", label: "Retrieved", source: "retrieved", score: 10 },
      { id: "selection", label: "Selection", source: "selection", score: 0 },
    ]);

    expect(ranked[0]?.id).toBe("selection");
  });

  it("keeps same-file neighborhood ahead of semantic-only retrieval", () => {
    const ranked = rankContextCandidates([
      { id: "semantic", label: "Semantic", source: "retrieved", score: 100 },
      { id: "local", label: "Local", source: "local_neighborhood", score: 0 },
    ]);

    expect(ranked[0]?.id).toBe("local");
  });

  it("collapses duplicate retrieved chunks by keeping the highest score", () => {
    const ranked = dedupeAndRankRetrievedChunks(
      [
        {
          chunkId: "chunk-1",
          filePath: "/tmp/example.ts",
          startLine: 1,
          endLine: 10,
          excerpt: "hello",
          scores: {
            direct: 0,
            symbol: 0.2,
            path: 0,
            lexical: 0.2,
            semantic: 0.1,
            total: 0.5,
          },
          provenance: {
            kind: "semantic_hit",
            workspaceId: "workspace-1",
            query: "hello",
            matchedTerms: ["hello"],
          },
        },
        {
          chunkId: "chunk-2",
          filePath: "/tmp/example.ts",
          startLine: 1,
          endLine: 10,
          excerpt: "hello",
          scores: {
            direct: 1,
            symbol: 0.2,
            path: 0,
            lexical: 0.2,
            semantic: 0.1,
            total: 6.5,
          },
          provenance: {
            kind: "direct_hit",
            workspaceId: "workspace-1",
            query: "hello",
            matchedTerms: ["hello"],
          },
        },
      ],
      { maxResults: 5 },
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.chunkId).toBe("chunk-2");
  });
});

describe("retrieval index", () => {
  it("updates indexed chunks incrementally when workspace files change", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "little-helper-index-"),
    );
    const index = new RetrievalIndex(path.join(workspace, ".index"));
    const sourceFile = path.join(workspace, "service.ts");

    await writeFile(
      sourceFile,
      "export function greet() {\n  return 'hello';\n}\n",
      "utf8",
    );
    await index.updateFromFiles({
      workspaceId: "workspace-1",
      workspaceRoot: workspace,
      filePaths: [sourceFile],
    });
    const initial = await index.search({
      workspaceId: "workspace-1",
      workspaceRoot: workspace,
      query: "greet hello",
      activeFile: path.join(workspace, "other.ts"),
      relatedFiles: [],
      maxResults: 5,
    });
    expect(initial[0]?.excerpt).toContain("hello");

    await writeFile(
      sourceFile,
      "export function greet() {\n  return 'hola';\n}\n",
      "utf8",
    );
    await index.updateFromFiles({
      workspaceId: "workspace-1",
      workspaceRoot: workspace,
      filePaths: [sourceFile],
    });
    const updated = await index.search({
      workspaceId: "workspace-1",
      workspaceRoot: workspace,
      query: "greet hola",
      activeFile: path.join(workspace, "other.ts"),
      relatedFiles: [],
      maxResults: 5,
    });

    expect(updated[0]?.excerpt).toContain("hola");
  });
});
