export type ClientRunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "blocked";
export type ClientApprovalDecision = "approved" | "denied";
export type ClientStreamEventType =
  | "session.created"
  | "message.created"
  | "run.started"
  | "run.status_changed"
  | "agent.started"
  | "agent.completed"
  | "assistant.delta"
  | "assistant.completed"
  | "approval.required"
  | "approval.resolved"
  | "run.completed"
  | "run.failed";

export interface SessionCreateInput {
  externalUserId: string;
  metadata?: Record<string, unknown>;
  workingDirectory: string;
  profile?: string;
  mode?: "suggest" | "auto-edit" | "full-auto";
  model?: string;
}

export interface SessionResponse {
  sessionId: string;
  status: string;
  createdAt: string;
}

export interface SessionSummary {
  sessionId: string;
  externalUserId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  pendingApprovalsCount: number;
  metadata: Record<string, unknown>;
}

export interface MessageRecord {
  messageId: string;
  tenantId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  runId?: string;
}

export interface MessageCreateInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MessageResponse {
  messageId: string;
  runId: string;
  streamUrl: string;
  status: ClientRunStatus;
}

export interface RunResponse {
  runId: string;
  sessionId: string;
  status: ClientRunStatus;
  summary?: string;
  evaluationStatus?: "pass" | "fail" | "needs_revision";
  approvalState: "none" | "pending" | "approved" | "denied";
  assistantReply?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  approvalId: string;
  tenantId: string;
  runId: string;
  sessionId: string;
  toolName: string;
  reason: string;
  stepId?: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decisionAt?: string;
}

export interface StreamEvent {
  eventId: string;
  type: ClientStreamEventType;
  timestamp: string;
  sessionId: string;
  runId: string;
  data: Record<string, unknown>;
}

export interface LittleHelperClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export interface StreamOptions {
  lastEventId?: string;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void | Promise<void>;
}

export interface SendMessageStreamResult {
  message: MessageResponse;
  terminalEvent?: StreamEvent;
}

export class LittleHelperClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  public readonly sessions = {
    create: async (input: SessionCreateInput): Promise<SessionResponse> =>
      this.requestJson("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    get: async (sessionId: string): Promise<SessionSummary> => this.requestJson(`/v1/sessions/${sessionId}`),
    listMessages: async (sessionId: string): Promise<MessageRecord[]> =>
      this.requestJson(`/v1/sessions/${sessionId}/messages`),
  };

  public readonly chat = {
    sendMessage: async (sessionId: string, input: MessageCreateInput): Promise<MessageResponse> =>
      this.requestJson(`/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    sendMessageStream: async (
      sessionId: string,
      input: MessageCreateInput,
      options: StreamOptions = {},
    ): Promise<SendMessageStreamResult> => {
      const message = await this.chat.sendMessage(sessionId, input);
      const terminalEvent = await this.runs.stream(message.runId, options);
      return terminalEvent
        ? {
        message,
        terminalEvent,
          }
        : { message };
    },
  };

  public readonly runs = {
    get: async (runId: string): Promise<RunResponse> => this.requestJson(`/v1/runs/${runId}`),
    stream: async (runId: string, options: StreamOptions = {}): Promise<StreamEvent | undefined> => {
      const response = await this.fetchImpl(this.resolvePath(`/v1/runs/${runId}/stream`), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "text/event-stream",
          ...(options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}),
        },
        signal: options.signal ?? null,
      });
      if (!response.ok) {
        throw await buildRequestError(response);
      }
      let terminalEvent: StreamEvent | undefined;
      for await (const event of parseSseStream(response)) {
        await options.onEvent?.(event);
        if (
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "approval.required" ||
          event.data.status === "blocked"
        ) {
          terminalEvent = event;
        }
      }
      return terminalEvent;
    },
  };

  public readonly approvals = {
    list: async (runId: string): Promise<ApprovalRecord[]> => this.requestJson(`/v1/runs/${runId}/approvals`),
    decide: async (approvalId: string, decision: ClientApprovalDecision): Promise<ApprovalRecord> =>
      this.requestJson(`/v1/approvals/${approvalId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
  };

  public constructor(options: LittleHelperClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(this.resolvePath(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw await buildRequestError(response);
    }
    return (await response.json()) as T;
  }

  private resolvePath(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

async function* parseSseStream(response: Response): AsyncGenerator<StreamEvent> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (event) {
        yield event;
      }
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim().length > 0) {
    const event = parseSseFrame(buffer);
    if (event) {
      yield event;
    }
  }
}

function parseSseFrame(frame: string): StreamEvent | undefined {
  const lines = frame.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data += `${line.slice(5).trimStart()}\n`;
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return JSON.parse(data.trim()) as StreamEvent;
}

async function buildRequestError(response: Response): Promise<Error> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text();
  }
  return new Error(`Request failed with ${response.status}: ${JSON.stringify(body)}`);
}
