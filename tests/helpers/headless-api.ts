import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "../../src/logger.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { InMemoryRepositoryBundle } from "../../src/repositories/in-memory.js";
import { createHeadlessApiFetch } from "../../src/server/app.js";
import { HeadlessPlatform } from "../../src/service/platform.js";
import type { Settings } from "../../src/schemas.js";
import { DeterministicTestLLMClient } from "./fake-llm.js";

export async function createHeadlessTestHarness(options: {
  approvalMode?: Settings["approvalMode"];
} = {}): Promise<{
  platform: HeadlessPlatform;
  fetchImpl: typeof fetch;
  baseUrl: string;
  apiKey: string;
  secondTenantApiKey: string;
  workspace: string;
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-headless-"));
  const artifactDir = path.join(workspace, ".runs");
  const settings: Settings = {
    env: "test",
    logLevel: "info",
    artifactDir,
    llmProvider: "openai",
    llmModel: "gpt-5.4-test",
    llmRouting: {},
    maxIterations: 2,
    approvalMode: options.approvalMode ?? "on-risk",
    outputFormat: "json",
    stream: true,
    maxToolOutputChars: 8_000,
    commandTimeoutMs: 30_000,
    shellAllowlist: ["node", "pnpm", "git"],
    validationCommands: [],
    allowedRoots: [workspace],
    networkAllowlist: [],
    skillDirectories: {
      project: [path.join(workspace, ".little-helper", "skills")],
      user: [path.join(workspace, ".user-skills")],
    },
    mcpServers: [],
  };
  const repositories = new InMemoryRepositoryBundle();
  const tenant = await repositories.createTenant("tenant-a");
  const otherTenant = await repositories.createTenant("tenant-b");
  const { apiKey } = await repositories.issueApiKey(tenant.tenantId, "primary");
  const { apiKey: secondTenantApiKey } = await repositories.issueApiKey(otherTenant.tenantId, "secondary");
  const logger = createLogger(settings);
  const platform = new HeadlessPlatform(settings, repositories.repositories, {
    logger,
    createOrchestrator: ({ onEvent }) =>
      new Orchestrator(settings, logger, {
        llm: new DeterministicTestLLMClient(),
        onEvent,
      }),
    worker: {
      autostart: true,
      pollIntervalMs: 10,
      leaseDurationMs: 500,
    },
  });
  const baseUrl = "http://headless.test";
  return {
    platform,
    fetchImpl: createHeadlessApiFetch(platform),
    baseUrl,
    apiKey,
    secondTenantApiKey,
    workspace,
  };
}

export async function closeHeadlessTestHarness(platform: HeadlessPlatform): Promise<void> {
  platform.worker.stop();
}

export async function waitForRun(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  runId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetchImpl(`${baseUrl}/v1/runs/${runId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (body.status === "completed" || body.status === "failed" || body.status === "blocked" || body.status === "awaiting_approval") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} did not settle in time.`);
}

export async function collectSseEvents(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  runId: string,
  lastEventId?: string,
): Promise<Array<{ eventId: string; type: string; data: Record<string, unknown> }>> {
  const response = await fetchImpl(`${baseUrl}/v1/runs/${runId}/stream`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`SSE request failed with status ${response.status}`);
  }
  if (!response.body) {
    return [];
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ eventId: string; type: string; data: Record<string, unknown> }> = [];
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!dataLine) {
        continue;
      }
      events.push(JSON.parse(dataLine) as { eventId: string; type: string; data: Record<string, unknown> });
    }
    if (done) {
      break;
    }
  }
  return events;
}
