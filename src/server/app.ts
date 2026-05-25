import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

import type { HeadlessEvent } from "../schemas.js";
import type { HeadlessPlatform } from "../service/platform.js";

export function createHeadlessApiFetch(platform: HeadlessPlatform): typeof fetch {
  return async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return handleHeadlessApiRequest(platform, request);
  };
}

export async function handleHeadlessApiRequest(platform: HeadlessPlatform, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && pathname === "/v1/health") {
    return jsonResponse(200, { ok: true, ready: true });
  }

  const auth = await authenticate(platform, request);
  if (!auth) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  if (method === "POST" && pathname === "/v1/sessions") {
    return jsonResponse(201, await platform.sessions.createSession(auth.tenantId, await readJsonBody(request)));
  }

  const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    const session = await platform.sessions.getSession(auth.tenantId, decodeURIComponent(sessionMatch[1] ?? ""));
    return session ? jsonResponse(200, session) : jsonResponse(404, { error: "not_found" });
  }

  const sessionMessagesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
  if (sessionMessagesMatch) {
    const sessionId = decodeURIComponent(sessionMessagesMatch[1] ?? "");
    const session = await platform.sessions.getSession(auth.tenantId, sessionId);
    if (!session) {
      return jsonResponse(404, { error: "not_found" });
    }
    if (method === "GET") {
      return jsonResponse(200, await platform.sessions.listMessages(auth.tenantId, sessionId));
    }
    if (method === "POST") {
      const created = await platform.runs.createMessageAndRun(auth.tenantId, sessionId, await readJsonBody(request));
      return jsonResponse(201, created.response);
    }
  }

  const runMatch = pathname.match(/^\/v1\/runs\/([^/]+)$/);
  if (method === "GET" && runMatch) {
    const run = await platform.runs.getRun(auth.tenantId, decodeURIComponent(runMatch[1] ?? ""));
    return run ? jsonResponse(200, run) : jsonResponse(404, { error: "not_found" });
  }

  const runApprovalsMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/approvals$/);
  if (method === "GET" && runApprovalsMatch) {
    const runId = decodeURIComponent(runApprovalsMatch[1] ?? "");
    const run = await platform.runs.getRun(auth.tenantId, runId);
    if (!run) {
      return jsonResponse(404, { error: "not_found" });
    }
    return jsonResponse(200, await platform.approvals.list(auth.tenantId, runId));
  }

  const decisionMatch = pathname.match(/^\/v1\/approvals\/([^/]+)\/decision$/);
  if (method === "POST" && decisionMatch) {
    const approval = await platform.approvals.decide(
      auth.tenantId,
      decodeURIComponent(decisionMatch[1] ?? ""),
      await readJsonBody(request),
    );
    return approval ? jsonResponse(200, approval) : jsonResponse(404, { error: "not_found" });
  }

  const streamMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/stream$/);
  if (method === "GET" && streamMatch) {
    const runId = decodeURIComponent(streamMatch[1] ?? "");
    const run = await platform.runs.getRun(auth.tenantId, runId);
    if (!run) {
      return jsonResponse(404, { error: "not_found" });
    }
    return sseResponse(platform, auth.tenantId, runId, request.headers.get("Last-Event-ID") ?? undefined);
  }

  return jsonResponse(404, { error: "not_found" });
}

export function createHeadlessApiServer(platform: HeadlessPlatform): Server {
  return createServer(async (incoming, outgoing) => {
    const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
      method: incoming.method ?? "GET",
      headers: new Headers(
        Object.entries(incoming.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : (value ?? []).map((item) => [key, item]),
        ),
      ),
      ...(incoming.method === "GET" || incoming.method === "HEAD"
        ? {}
        : { body: Readable.toWeb(incoming) as never }),
    });
    const response = await handleHeadlessApiRequest(platform, request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => {
      outgoing.setHeader(key, value);
    });
    if (!response.body) {
      outgoing.end();
      return;
    }
    await Readable.fromWeb(response.body).pipe(outgoing);
  });
}

async function authenticate(
  platform: HeadlessPlatform,
  request: Request,
): Promise<{ tenantId: string } | undefined> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  return platform.authenticate(authorization.slice("Bearer ".length).trim());
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.length > 0 ? JSON.parse(text) : {};
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function sseResponse(
  platform: HeadlessPlatform,
  tenantId: string,
  runId: string,
  lastEventId?: string,
): Promise<Response> {
  const run = await platform.runs.getRun(tenantId, runId);
  if (!run) {
    return jsonResponse(404, { error: "not_found" });
  }
  const encoder = new TextEncoder();
  const replay = await platform.streams.replay(tenantId, runId, lastEventId);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: HeadlessEvent) => {
        controller.enqueue(encoder.encode(serializeSseEvent(event)));
      };
      for (const event of replay) {
        write(event);
      }
      if (isRunTerminal(run.status) || replay.some((event) => isTerminalStreamEvent(event.type, event.data.status))) {
        controller.close();
        return;
      }
      const unsubscribe = platform.streams.subscribe(runId, (event) => {
        if (event.tenantId !== tenantId) {
          return;
        }
        write(event);
        if (isTerminalStreamEvent(event.type, event.data.status)) {
          unsubscribe();
          controller.close();
        }
      });
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function serializeSseEvent(event: HeadlessEvent): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isRunTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "blocked";
}

function isTerminalStreamEvent(type: string, status: unknown): boolean {
  return (
    type === "run.completed" ||
    type === "run.failed" ||
    type === "approval.required" ||
    status === "blocked"
  );
}
