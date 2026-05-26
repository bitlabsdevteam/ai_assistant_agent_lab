import { describe, expect, it } from "vitest";

import { renderApprovals } from "../../src/rendering/approvals.js";

describe("approvals rendering", () => {
  it("renders compact approval guidance in text mode", () => {
    const lines: string[] = [];

    renderApprovals(
      {
        writeLine: (line) => lines.push(line),
      },
      [
        {
          id: "approval-1",
          runId: "run-1",
          createdAt: new Date().toISOString(),
          status: "pending",
          toolName: "web.search",
          reason: "Network access to 'api.perplexity.ai' requires approval because network access is disabled by default.",
          riskLevel: "medium",
          actionSummary: "Search weather",
          inputDigest: "digest-1",
        },
      ],
      "text",
      {
        runId: "run-1",
      },
    );

    expect(lines).toEqual([
      "Approvals for run run-1:",
      "approval-1: Search the web. Network access needs approval. Status: pending.",
      'Approve with "argus approvals run-1 --approve <approvalId> --resume" to continue immediately, or run "argus resume run-1" after approval.',
    ]);
  });

  it("renders decision follow-up with resume guidance", () => {
    const lines: string[] = [];

    renderApprovals(
      {
        writeLine: (line) => lines.push(line),
      },
      [],
      "text",
      {
        runId: "run-2",
        decision: {
          approvalId: "approval-2",
          status: "approved",
        },
      },
    );

    expect(lines).toEqual([
      "Approved approval-2.",
      'Use "argus resume run-2" to continue.',
      "No approvals recorded for run run-2.",
    ]);
  });
});
