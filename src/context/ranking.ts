import type { RetrievedContextChunk } from "../schemas.js";

export interface RankedContextCandidate {
  id: string;
  label: string;
  source: "selection" | "local_neighborhood" | "retrieved";
  score: number;
}

const SOURCE_PRIORITY: Record<RankedContextCandidate["source"], number> = {
  selection: 3_000,
  local_neighborhood: 2_000,
  retrieved: 1_000,
};

export function rankContextCandidates<T extends RankedContextCandidate>(
  candidates: T[],
): T[] {
  return candidates
    .slice()
    .sort(
      (left, right) =>
        SOURCE_PRIORITY[right.source] +
        right.score -
        (SOURCE_PRIORITY[left.source] + left.score),
    );
}

export function dedupeAndRankRetrievedChunks(
  chunks: RetrievedContextChunk[],
  options: {
    maxResults: number;
  },
): RetrievedContextChunk[] {
  const deduped = new Map<string, RetrievedContextChunk>();
  for (const chunk of chunks) {
    const key = `${chunk.filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.symbol ?? ""}`;
    const existing = deduped.get(key);
    if (!existing || chunk.scores.total > existing.scores.total) {
      deduped.set(key, chunk);
    }
  }

  return [...deduped.values()]
    .sort(compareRetrievedChunks)
    .slice(0, options.maxResults);
}

function compareRetrievedChunks(
  left: RetrievedContextChunk,
  right: RetrievedContextChunk,
): number {
  const categoryDelta =
    retrievalCategoryScore(right) - retrievalCategoryScore(left);
  if (categoryDelta !== 0) {
    return categoryDelta;
  }
  const totalDelta = right.scores.total - left.scores.total;
  if (totalDelta !== 0) {
    return totalDelta;
  }
  const lexicalDelta = right.scores.lexical - left.scores.lexical;
  if (lexicalDelta !== 0) {
    return lexicalDelta;
  }
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.startLine - right.startLine
  );
}

function retrievalCategoryScore(chunk: RetrievedContextChunk): number {
  switch (chunk.provenance.kind) {
    case "direct_hit":
      return 4;
    case "symbol_hit":
      return 3;
    case "path_hit":
      return 2;
    case "semantic_hit":
      return 1;
  }
}
