import { afterEach, describe, expect, it } from "vitest";

import { LittleHelperClient } from "../../packages/sdk/src/index.js";
import { closeHeadlessTestHarness, createHeadlessTestHarness } from "../helpers/headless-api.js";

const activeHarnesses: Array<Awaited<ReturnType<typeof createHeadlessTestHarness>>> = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const harness = activeHarnesses.pop();
    if (harness) {
      await closeHeadlessTestHarness(harness.platform);
    }
  }
});

describe("headless SDK", () => {
  it("sendMessageStream yields normalized events in order and resolves on completion", async () => {
    const harness = await createHeadlessTestHarness();
    activeHarnesses.push(harness);
    const client = new LittleHelperClient({
      baseUrl: harness.baseUrl,
      apiKey: harness.apiKey,
      fetch: harness.fetchImpl,
    });

    const session = await client.sessions.create({
      externalUserId: "sdk-user-1",
      workingDirectory: harness.workspace,
    });
    const eventTypes: string[] = [];
    const result = await client.chat.sendMessageStream(
      session.sessionId,
      {
        content: "hello",
      },
      {
        onEvent: async (event) => {
          eventTypes.push(event.type);
        },
      },
    );

    expect(result.message.runId.length).toBeGreaterThan(0);
    expect(eventTypes[0]).toBe("message.created");
    expect(eventTypes).toContain("assistant.completed");
    expect(result.terminalEvent?.type).toBe("run.completed");
  });

  it("surfaces approval-required state as structured data and continues after approval", async () => {
    const harness = await createHeadlessTestHarness({ approvalMode: "always" });
    activeHarnesses.push(harness);
    const client = new LittleHelperClient({
      baseUrl: harness.baseUrl,
      apiKey: harness.apiKey,
      fetch: harness.fetchImpl,
    });

    const session = await client.sessions.create({
      externalUserId: "sdk-user-2",
      workingDirectory: harness.workspace,
    });
    const firstPass = await client.chat.sendMessageStream(session.sessionId, {
      content: "Create file gated-sdk.txt with content gated hello",
    });

    expect(firstPass.terminalEvent?.type).toBe("approval.required");

    const approvals = await client.approvals.list(firstPass.message.runId);
    expect(approvals[0]?.status).toBe("pending");
    await client.approvals.decide(approvals[0]!.approvalId, "approved");

    const replayedTypes: string[] = [];
    const terminal = await client.runs.stream(firstPass.message.runId, {
      ...(firstPass.terminalEvent?.eventId ? { lastEventId: firstPass.terminalEvent.eventId } : {}),
      onEvent: async (event) => {
        replayedTypes.push(event.type);
      },
    });

    expect(replayedTypes).toContain("approval.resolved");
    expect(terminal?.type).toBe("run.completed");
  });
});
