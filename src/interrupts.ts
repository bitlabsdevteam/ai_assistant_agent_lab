import process from "node:process";

import { toAbortError } from "./errors.js";
import type { OutputFormat } from "./schemas.js";

export interface EscapeInterruptWriter {
  writeLine(line: string): void;
}

export interface EscapeInterruptOptions {
  outputFormat: OutputFormat;
  enabled: boolean;
  writer: EscapeInterruptWriter;
  bindEscape?: (onEscape: () => void) => () => void;
  parentSignal?: AbortSignal;
  hint?: string;
  cancelMessage?: string;
}

export async function runWithEscapeCancellation<T>(
  options: EscapeInterruptOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abortController = new AbortController();
  const signal = options.parentSignal ? AbortSignal.any([options.parentSignal, abortController.signal]) : abortController.signal;
  const shouldRenderHint = options.enabled && options.outputFormat === "text";
  const releaseEscape = shouldRenderHint && options.bindEscape ? options.bindEscape(() => cancelCurrentRun(abortController, options)) : () => {};

  if (shouldRenderHint) {
    options.writer.writeLine(options.hint ?? "Press Esc to stop or cancel.");
  }

  try {
    return await operation(signal);
  } finally {
    releaseEscape();
  }
}

export function bindProcessEscape(onEscape: () => void): () => void {
  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return () => {};
  }

  const previousRawMode = Boolean(stdin.isRaw);
  const listener = (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === 0x1b) {
      onEscape();
    }
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", listener);

  return () => {
    stdin.off("data", listener);
    if (!previousRawMode) {
      stdin.setRawMode(false);
    }
  };
}

function cancelCurrentRun(controller: AbortController, options: EscapeInterruptOptions): void {
  if (controller.signal.aborted) {
    return;
  }
  if (options.outputFormat === "text") {
    options.writer.writeLine(options.cancelMessage ?? "Cancelling current task...");
  }
  controller.abort(toAbortError("Run cancelled by operator."));
}
