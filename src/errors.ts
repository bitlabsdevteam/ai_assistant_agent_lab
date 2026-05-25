export type ErrorCode =
  | "CONFIG_ERROR"
  | "POLICY_ERROR"
  | "TOOL_ERROR"
  | "LLM_ERROR"
  | "VALIDATION_ERROR"
  | "TIMEOUT_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Record<string, unknown> | undefined;
  public readonly exitCode: number;

  public constructor(
    code: ErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      details?: Record<string, unknown>;
      exitCode?: number;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.details = options?.details;
    this.exitCode = options?.exitCode ?? mapErrorCodeToExitCode(code);
  }
}

export function mapErrorCodeToExitCode(code: ErrorCode): number {
  switch (code) {
    case "CONFIG_ERROR":
    case "VALIDATION_ERROR":
      return 2;
    case "POLICY_ERROR":
      return 3;
    case "TOOL_ERROR":
    case "LLM_ERROR":
    case "TIMEOUT_ERROR":
    case "NOT_FOUND":
    case "INTERNAL_ERROR":
      return 4;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }

  const message =
    typeof reason === "string"
      ? reason
      : reason instanceof Error && reason.message.length > 0
        ? reason.message
        : "Operation aborted.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
