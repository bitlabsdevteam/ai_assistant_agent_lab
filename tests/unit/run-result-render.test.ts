import { describe, expect, it } from "vitest";

import { buildRunTextReply, renderRunResult } from "../../src/rendering/run-result.js";

describe("run result rendering", () => {
  it("prefers assistant responses for completed runs", () => {
    expect(
      buildRunTextReply({
        state: {
          runId: "run-1",
          status: "completed",
        } as never,
        execution: {
          assistantResponse: "Hello from the run path.",
          blockers: [],
          toolCalls: [],
        } as never,
        evaluation: undefined,
      }),
    ).toBe("Hello from the run path.");
  });

  it("renders concise approval text for awaiting approval runs", () => {
    expect(
      buildRunTextReply({
        state: {
          runId: "run-2",
          status: "awaiting_approval",
        } as never,
        execution: {
          blockers: [],
          toolCalls: [
            {
              toolName: "web.search",
              approvalProvenance: "pending",
              status: "skipped",
            },
          ],
        } as never,
        evaluation: undefined,
      }),
    ).toBe(
      'Approval required to search the web. Run run-2 is awaiting approval. Use "argus approvals run-2 --approve <approvalId> --resume" to continue immediately, or inspect approvals first with "argus approvals run-2".',
    );
  });

  it("suppresses duplicate assistant replies when the answer already streamed", () => {
    const lines: string[] = [];

    renderRunResult(
      {
        writeLine: (line) => lines.push(line),
      },
      {
        state: {
          runId: "run-3",
          status: "completed",
        } as never,
        execution: {
          assistantResponse: "Streamed answer",
          blockers: [],
          toolCalls: [],
        } as never,
        evaluation: undefined,
      },
      "text",
      {
        omitAssistantReply: true,
      },
    );

    expect(lines).toEqual([]);
  });
});
