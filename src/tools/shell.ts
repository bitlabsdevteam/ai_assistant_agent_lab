import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError, toAbortError } from "../errors.js";
import { SessionStore } from "../memory/session-store.js";
import type { TerminalSessionState } from "../schemas.js";
import { redactSecrets } from "../policy/safety.js";
import { type SessionController, type ToolContext, buildDescriptor, type Tool } from "./base.js";

const ExecInputSchema = z.object({
  command: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().optional(),
});
const ExecOutputSchema = z.object({
  command: z.array(z.string()),
  normalizedCommand: z.string(),
  cwd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutSummary: z.string(),
  stderrSummary: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  exitCode: z.number().int(),
});

export class ShellTool implements Tool<typeof ExecInputSchema, typeof ExecOutputSchema>, SessionController {
  public readonly descriptor = buildDescriptor({
    name: "shell.exec",
    description: "Run an allowlisted shell command.",
    category: "execution",
    riskLevel: "medium",
    sideEffecting: true,
    permissionScope: "shell",
  });
  public readonly inputSchema = ExecInputSchema;
  public readonly outputSchema = ExecOutputSchema;
  private readonly sessions = new Map<
    string,
    {
      state: TerminalSessionState;
      process: ChildProcessWithoutNullStreams;
    }
  >();

  public validate(input: z.infer<typeof ExecInputSchema>, context: ToolContext): void {
    context.policy.ensureShellAllowed(input.command);
  }

  public async run(input: z.infer<typeof ExecInputSchema>, context: ToolContext): Promise<z.infer<typeof ExecOutputSchema>> {
    this.validate(input, context);
    if (context.dryRun) {
      return {
        command: input.command,
        normalizedCommand: input.command.join(" "),
        cwd: context.workingDirectory,
        stdout: "",
        stderr: "",
        stdoutSummary: "Dry run: command not executed.",
        stderrSummary: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
      };
    }

    return new Promise((resolve, reject) => {
      const executable = input.command[0];
      if (!executable) {
        reject(new AppError("VALIDATION_ERROR", "Shell command requires an executable."));
        return;
      }
      const sessionStore = new SessionStore(context.artifactStore);
      const sessionId = randomUUID();
      const now = new Date().toISOString();
      const child: ChildProcessWithoutNullStreams = spawn(executable, input.command.slice(1), {
        cwd: context.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pid = child.pid;
      const pendingSession: TerminalSessionState = {
        sessionId,
        command: input.command,
        mode: "non_interactive",
        startedAt: now,
        lastActivityAt: now,
        status: "running",
        ...(pid ? { pid } : {}),
      };
      let stdout = "";
      let stderr = "";
      let settled = false;
      void sessionStore.upsert(pendingSession);

      const abortListener = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        const endedAt = new Date().toISOString();
        void sessionStore.upsert({
          ...pendingSession,
          lastActivityAt: endedAt,
          status: "cancelled",
          endedAt,
          terminationReason: "operator_cancelled",
        });
        reject(toAbortError(context.signal.reason));
      };

      const timeoutMs = input.timeoutMs ?? context.settings.commandTimeoutMs;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        context.signal.removeEventListener("abort", abortListener);
        void sessionStore.upsert({
          ...pendingSession,
          lastActivityAt: new Date().toISOString(),
          status: "timed_out",
          endedAt: new Date().toISOString(),
          terminationReason: "timed_out",
        });
        reject(new AppError("TIMEOUT_ERROR", `Command timed out: ${input.command.join(" ")}`));
      }, timeoutMs);
      context.signal.addEventListener("abort", abortListener, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        void sessionStore.upsert({
          ...pendingSession,
          lastActivityAt: new Date().toISOString(),
          status: "running",
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        void sessionStore.upsert({
          ...pendingSession,
          lastActivityAt: new Date().toISOString(),
          status: "running",
        });
      });
      child.on("error", (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", abortListener);
        void sessionStore.upsert({
          ...pendingSession,
          lastActivityAt: new Date().toISOString(),
          status: "failed",
          endedAt: new Date().toISOString(),
          terminationReason: "failed",
        });
        reject(new AppError("TOOL_ERROR", `Failed to execute command: ${executable}`, { cause: error }));
      });
      child.on("close", (exitCode: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", abortListener);
        const endedAt = new Date().toISOString();
        void persistTerminalState(
          sessionStore,
          sessionId,
          {
            ...pendingSession,
            lastActivityAt: endedAt,
            status: exitCode === 0 ? "completed" : "failed",
            endedAt,
            terminationReason: exitCode === 0 ? "completed" : "failed",
            ...(exitCode !== null ? { exitCode } : {}),
          },
          exitCode,
        );
        resolve({
          command: input.command,
          normalizedCommand: input.command.join(" "),
          cwd: context.workingDirectory,
          stdout: truncate(redactSecrets(stdout), context.settings.maxToolOutputChars),
          stderr: truncate(redactSecrets(stderr), context.settings.maxToolOutputChars),
          stdoutSummary: summarizeStream(stdout),
          stderrSummary: summarizeStream(stderr),
          stdoutTruncated: stdout.length > context.settings.maxToolOutputChars,
          stderrTruncated: stderr.length > context.settings.maxToolOutputChars,
          exitCode: exitCode ?? 1,
        });
      });
    });
  }

  public start(command: string[], context: ToolContext): Promise<TerminalSessionState> {
    context.policy.ensureShellAllowed(command);
    const executable = command[0];
    if (!executable) {
      throw new AppError("VALIDATION_ERROR", "Shell command requires an executable.");
    }
    const child: ChildProcessWithoutNullStreams = spawn(executable, command.slice(1), {
      cwd: context.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = child.pid;
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const state: TerminalSessionState = {
      sessionId,
      command,
      mode: "pty",
      startedAt: now,
      lastActivityAt: now,
      status: "running",
      ...(pid ? { pid } : {}),
    };
    this.sessions.set(sessionId, { state, process: child });
    const sessionStore = new SessionStore(context.artifactStore);
    void sessionStore.upsert(state);
    child.on("close", (exitCode: number | null) => {
      const active = this.sessions.get(sessionId);
      if (!active) {
        return;
      }
      const endedAt = new Date().toISOString();
      const fallbackState: TerminalSessionState = {
        ...active.state,
        lastActivityAt: endedAt,
        status: exitCode === 0 ? "completed" : "failed",
        endedAt,
        terminationReason: exitCode === 0 ? "completed" : "failed",
        ...(exitCode !== null ? { exitCode } : {}),
      };
      active.state = fallbackState;
      this.sessions.set(sessionId, active);
      void persistTerminalState(sessionStore, sessionId, fallbackState, exitCode).then((resolved) => {
        const latest = this.sessions.get(sessionId);
        if (!latest) {
          return;
        }
        latest.state = resolved;
        this.sessions.set(sessionId, latest);
      });
    });
    return Promise.resolve(state);
  }

  public poll(sessionId: string): Promise<TerminalSessionState | undefined> {
    const inMemory = this.sessions.get(sessionId)?.state;
    if (inMemory) {
      return Promise.resolve(inMemory);
    }
    return Promise.resolve(undefined);
  }

  public stop(sessionId: string): Promise<TerminalSessionState | undefined> {
    const active = this.sessions.get(sessionId);
    if (!active) {
      return Promise.resolve(undefined);
    }
    active.process.kill("SIGTERM");
    active.state = {
      ...active.state,
      lastActivityAt: new Date().toISOString(),
      status: "cancelled",
      endedAt: new Date().toISOString(),
      terminationReason: "operator_cancelled",
    };
    this.sessions.set(sessionId, active);
    return Promise.resolve(active.state);
  }
}

export class ValidationTool implements Tool<typeof ExecInputSchema, typeof ExecOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "validation.run",
    description: "Run an allowlisted validation command.",
    category: "validation",
    riskLevel: "low",
    sideEffecting: false,
    permissionScope: "shell",
  });
  public readonly inputSchema = ExecInputSchema;
  public readonly outputSchema = ExecOutputSchema;

  public validate(input: z.infer<typeof ExecInputSchema>, context: ToolContext): void {
    context.policy.ensureShellAllowed(input.command);
  }

  public async run(input: z.infer<typeof ExecInputSchema>, context: ToolContext): Promise<z.infer<typeof ExecOutputSchema>> {
    const shell = new ShellTool();
    return shell.run(input, { ...context, dryRun: false });
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function summarizeStream(value: string): string {
  const normalized = redactSecrets(value).replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 240)}...`;
}

async function persistTerminalState(
  sessionStore: SessionStore,
  sessionId: string,
  fallbackState: TerminalSessionState,
  exitCode: number | null,
): Promise<TerminalSessionState> {
  const persisted = await sessionStore.get(sessionId);
  const alreadyTerminal = persisted && persisted.status !== "running";
  const nextState = alreadyTerminal
    ? {
        ...persisted,
        ...(exitCode !== null && persisted.exitCode === undefined ? { exitCode } : {}),
      }
    : fallbackState;
  await sessionStore.upsert(nextState);
  return nextState;
}
