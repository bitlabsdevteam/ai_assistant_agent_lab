import { afterEach, describe, expect, it } from "vitest";

import type { SessionResponse } from "../../packages/sdk/src/index.js";
import {
  closeHeadlessTestHarness,
  collectSseEvents,
  createHeadlessTestHarness,
  waitForRun,
} from "../helpers/headless-api.js";

const activeHarnesses: Array<Awaited<ReturnType<typeof createHeadlessTestHarness>>> = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const harness = activeHarnesses.pop();
    if (harness) {
      await closeHeadlessTestHarness(harness.platform);
    }
  }
});

describe("headless conversation API", () => {
  it("creates sessions, sends messages, persists transcript, and exposes run state", async () => {
    const harness = await createHeadlessTestHarness();
    activeHarnesses.push(harness);

    const sessionResponse = await harness.fetchImpl(`${harness.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        externalUserId: "user-1",
        metadata: { source: "crm" },
        workingDirectory: harness.workspace,
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as SessionResponse;

    const messageResponse = await harness.fetchImpl(`${harness.baseUrl}/v1/sessions/${session.sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: "Create file hello.txt with content hello world",
      }),
    });
    expect(messageResponse.status).toBe(201);
    const message = (await messageResponse.json()) as { runId: string; messageId: string };

    const run = await waitForRun(harness.fetchImpl, harness.baseUrl, harness.apiKey, message.runId);
    expect(run.status).toBe("completed");
    expect(run.approvalState).toBe("none");
    expect(String(run.assistantReply)).toContain("hello.txt");

    const transcriptResponse = await harness.fetchImpl(`${harness.baseUrl}/v1/sessions/${session.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
      },
    });
    const transcript = (await transcriptResponse.json()) as Array<{ role: string; runId?: string }>;
    expect(transcript.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(transcript[0]?.runId).toBe(message.runId);
    expect(transcript[1]?.runId).toBe(message.runId);

    const sessionSummaryResponse = await harness.fetchImpl(`${harness.baseUrl}/v1/sessions/${session.sessionId}`, {
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
      },
    });
    const sessionSummary = (await sessionSummaryResponse.json()) as { pendingApprovalsCount: number; activeRunId?: string };
    expect(sessionSummary.pendingApprovalsCount).toBe(0);
    expect(sessionSummary.activeRunId).toBeUndefined();
  });

  it("replays ordered SSE events and supports Last-Event-ID reconnect", async () => {
    const harness = await createHeadlessTestHarness();
    activeHarnesses.push(harness);

    const session = (await (
      await harness.fetchImpl(`${harness.baseUrl}/v1/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          externalUserId: "user-2",
          workingDirectory: harness.workspace,
        }),
      })
    ).json()) as SessionResponse;

    const created = (await (
      await harness.fetchImpl(`${harness.baseUrl}/v1/sessions/${session.sessionId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "hello",
        }),
      })
    ).json()) as { runId: string };

    const firstPass = await collectSseEvents(harness.fetchImpl, harness.baseUrl, harness.apiKey, created.runId);
    expect(firstPass[0]?.type).toBe("message.created");
    expect(firstPass.some((event) => event.type === "assistant.delta")).toBe(true);
    expect(firstPass.at(-1)?.type).toBe("run.completed");

    const resumeFrom = firstPass[1]?.eventId;
    expect(resumeFrom).toBeTruthy();
    const replayed = await collectSseEvents(harness.fetchImpl, harness.baseUrl, harness.apiKey, created.runId, resumeFrom);
    expect(replayed[0]?.eventId).not.toBe(firstPass[0]?.eventId);
    expect(replayed[0]?.eventId).not.toBe(resumeFrom);
    expect(replayed.at(-1)?.type).toBe("run.completed");
  });

  it("isolates tenants and rejects missing auth", async () => {
    const harness = await createHeadlessTestHarness();
    activeHarnesses.push(harness);

    const unauthorized = await harness.fetchImpl(`${harness.baseUrl}/v1/sessions`);
    expect(unauthorized.status).toBe(401);

    const session = (await (
      await harness.fetchImpl(`${harness.baseUrl}/v1/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          externalUserId: "user-3",
          workingDirectory: harness.workspace,
        }),
      })
    ).json()) as SessionResponse;

    const crossTenant = await harness.fetchImpl(`${harness.baseUrl}/v1/sessions/${session.sessionId}`, {
      headers: {
        Authorization: `Bearer ${harness.secondTenantApiKey}`,
      },
    });
    expect(crossTenant.status).toBe(404);
  });

  it("emits approval events, exposes approval APIs, and resumes after approval", async () => {
    const harness = await createHeadlessTestHarness({ approvalMode: "always" });
    activeHarnesses.push(harness);

    const session = (await (
      await harness.fetchImpl(`${harness.baseUrl}/v1/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          externalUserId: "user-4",
          workingDirectory: harness.workspace,
        }),
      })
    ).json()) as SessionResponse;

    const created = (await (
      await harness.fetchImpl(`${harness.baseUrl}/v1/sessions/${session.sessionId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "Create file gated.txt with content gated hello",
        }),
      })
    ).json()) as { runId: string };

    const approvalEvents = await collectSseEvents(harness.fetchImpl, harness.baseUrl, harness.apiKey, created.runId);
    expect(approvalEvents.some((event) => event.type === "approval.required")).toBe(true);

    const pendingRun = await waitForRun(harness.fetchImpl, harness.baseUrl, harness.apiKey, created.runId);
    expect(pendingRun.status).toBe("awaiting_approval");
    expect(pendingRun.approvalState).toBe("pending");

    const approvalsResponse = await harness.fetchImpl(`${harness.baseUrl}/v1/runs/${created.runId}/approvals`, {
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
      },
    });
    const approvals = (await approvalsResponse.json()) as Array<{ approvalId: string; status: string }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("pending");

    const decisionResponse = await harness.fetchImpl(`${harness.baseUrl}/v1/approvals/${approvals[0]?.approvalId}/decision`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        decision: "approved",
      }),
    });
    expect(decisionResponse.status).toBe(200);

    const resumedEvents = await collectSseEvents(
      harness.fetchImpl,
      harness.baseUrl,
      harness.apiKey,
      created.runId,
      approvalEvents.at(-1)?.eventId,
    );
    expect(resumedEvents.some((event) => event.type === "approval.resolved")).toBe(true);
    expect(resumedEvents.at(-1)?.type).toBe("run.completed");

    const finalRun = await waitForRun(harness.fetchImpl, harness.baseUrl, harness.apiKey, created.runId);
    expect(finalRun.status).toBe("completed");
  });
});
