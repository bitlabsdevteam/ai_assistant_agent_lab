import type { LLMStreamEvent } from "../llm/client.js";
import {
  LLMUsageTelemetryDetailsSchema,
  type LLMUsageTelemetryDetails,
  type OutputFormat,
  type TelemetryEvent,
} from "../schemas.js";

export interface TextOutputWriter {
  write(text: string): void;
  writeLine(line: string): void;
  isTTY?(): boolean;
}

type TextLLMRenderingMode = "internal" | "assistant";

interface WorkingIndicatorController {
  noteActivity(): void;
  noteVisibleOutput(): void;
  finish(): void;
}

interface UsageLineController {
  handleEvent(event: TelemetryEvent): boolean;
  noteVisibleOutput(): void;
  finish(): void;
}

interface RuntimeTextRendererOptions {
  textMode?: TextLLMRenderingMode;
  workingIndicator?: {
    delayMs?: number;
    frameIntervalMs?: number;
  };
}

interface StreamRendererState {
  buffer: string;
  stepId?: string;
  stepTitle?: string;
  stepHasTools?: boolean;
  streamedAssistantLength?: number;
  liveText?: boolean;
}

export function createLLMStreamRenderer(
  writer: TextOutputWriter,
  outputFormat: OutputFormat,
  options: {
    textMode?: TextLLMRenderingMode;
  } = {},
): {
  onLLMEvent: (event: LLMStreamEvent) => void;
  hasStreamedContent: () => boolean;
  hasStreamedAssistantContent: () => boolean;
  finish: () => void;
} {
  const states = new Map<LLMStreamEvent["role"], StreamRendererState>();
  const textMode = options.textMode ?? "internal";
  let streamedContent = false;
  let streamedAssistantContent = false;

  function getState(role: LLMStreamEvent["role"]): StreamRendererState {
    const existing = states.get(role);
    if (existing) {
      return existing;
    }
    const created: StreamRendererState = {
      buffer: "",
    };
    states.set(role, created);
    return created;
  }

  function flushRole(role: LLMStreamEvent["role"]): void {
    const state = states.get(role);
    if (state?.liveText) {
      writer.write("\n");
      states.delete(role);
      return;
    }

    const buffered = state?.buffer.trim() ?? "";
    if (buffered.length === 0) {
      states.delete(role);
      return;
    }

    const lines = summarizeStream(role, buffered, {
      ...(state?.stepId ? { stepId: state.stepId } : {}),
      ...(state?.stepTitle ? { stepTitle: state.stepTitle } : {}),
      ...(typeof state?.stepHasTools === "boolean" ? { stepHasTools: state.stepHasTools } : {}),
    }, textMode);
    if (lines.length > 0) {
      lines.forEach((line) => writer.writeLine(line));
      if (textMode === "assistant" && role === "executor") {
        streamedAssistantContent = true;
      }
    } else {
      if (textMode === "assistant") {
        states.delete(role);
        return;
      }
      writer.writeLine(`${formatRoleLabel(role)} output:`);
      writer.writeLine(buffered);
    }
    streamedContent = true;
    states.delete(role);
  }

  return {
    onLLMEvent: (event) => {
      if (outputFormat === "json") {
        writer.writeLine(JSON.stringify({ channel: "llm.event", ...event }));
        if (typeof event.delta === "string" && event.delta.length > 0) {
          streamedContent = true;
        }
        return;
      }

      const state = getState(event.role);
      if (typeof event.stepId === "string" && event.stepId.length > 0) {
        state.stepId = event.stepId;
      }
      if (typeof event.stepTitle === "string" && event.stepTitle.length > 0) {
        state.stepTitle = event.stepTitle;
      }
      if (typeof event.stepHasTools === "boolean") {
        state.stepHasTools = event.stepHasTools;
      }

      if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length > 0) {
        state.buffer += event.delta;
        if (textMode === "assistant") {
          if (event.role !== "executor") {
            return;
          }
          const assistantPreview = extractAssistantPreview(state.buffer, state.stepHasTools);
          if (assistantPreview !== undefined) {
            const alreadyStreamed = state.streamedAssistantLength ?? 0;
            if (assistantPreview.length > alreadyStreamed) {
              if (!state.liveText) {
                state.liveText = true;
              }
              writer.write(assistantPreview.slice(alreadyStreamed));
              state.streamedAssistantLength = assistantPreview.length;
              streamedContent = true;
              streamedAssistantContent = true;
            }
          }
          return;
        }
        if (shouldStreamLiveText(state.buffer)) {
          if (!state.liveText) {
            writer.write(`${formatRoleLabel(event.role)}: `);
            state.liveText = true;
          }
          writer.write(event.delta);
          streamedContent = true;
        }
        return;
      }

      if (
        event.type === "response.output_text.done" ||
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "error"
      ) {
        flushRole(event.role);
      }
    },
    hasStreamedContent: () => streamedContent,
    hasStreamedAssistantContent: () => streamedAssistantContent,
    finish: () => {
      if (outputFormat === "json") {
        return;
      }
      for (const role of states.keys()) {
        flushRole(role);
      }
    },
  };
}

export function createRuntimeTextRenderer(
  writer: TextOutputWriter,
  outputFormat: OutputFormat,
  options: RuntimeTextRendererOptions = {},
): {
  onEvent: (event: TelemetryEvent) => void;
  onLLMEvent: (event: LLMStreamEvent) => void;
  hasStreamedAssistantContent: () => boolean;
  write(text: string): void;
  writeLine(line: string): void;
  finish: () => void;
} {
  const workingIndicator = createWorkingIndicatorController(writer, outputFormat, options.workingIndicator);
  const usageLine = createUsageLineController(writer, outputFormat);
  const visibleWriter: TextOutputWriter = {
    write: (text) => {
      workingIndicator.noteVisibleOutput();
      usageLine.noteVisibleOutput();
      writer.write(text);
    },
    writeLine: (line) => {
      workingIndicator.noteVisibleOutput();
      usageLine.noteVisibleOutput();
      writer.writeLine(line);
    },
    ...(writer.isTTY ? { isTTY: () => writer.isTTY?.() ?? false } : {}),
  };
  const llmRenderer = createLLMStreamRenderer(visibleWriter, outputFormat, {
    ...(options.textMode ? { textMode: options.textMode } : {}),
  });

  return {
    onEvent: (event) => {
      workingIndicator.noteActivity();
      if (event.event === "llm.usage.updated") {
        workingIndicator.noteVisibleOutput();
      }
      if (usageLine.handleEvent(event)) {
        return;
      }
      renderHarnessEvent(visibleWriter, outputFormat, event);
    },
    onLLMEvent: (event) => {
      workingIndicator.noteActivity();
      llmRenderer.onLLMEvent(event);
    },
    hasStreamedAssistantContent: llmRenderer.hasStreamedAssistantContent,
    write: visibleWriter.write,
    writeLine: visibleWriter.writeLine,
    finish: () => {
      llmRenderer.finish();
      usageLine.finish();
      workingIndicator.finish();
    },
  };
}

export function renderHarnessEvent(writer: TextOutputWriter, outputFormat: OutputFormat, event: TelemetryEvent): void {
  if (outputFormat === "json") {
    writer.writeLine(JSON.stringify({ type: "harness.event", ...event }));
    return;
  }
  if (
    event.event === "harness.checkpoint_written" ||
    event.event === "harness.run_started" ||
    event.event === "harness.resumed" ||
    event.event === "harness.awaiting_approval" ||
    event.event === "llm.usage.updated" ||
    event.event === "evaluation.passed" ||
    event.event === "run.completed"
  ) {
    return;
  }
  if (event.event === "agent.started" || event.event === "agent.completed") {
    const agent = resolveAgentName(event);
    if (!agent) {
      const label = event.event.replaceAll(".", " ");
      writer.writeLine(`${label} (${event.status})`);
      return;
    }
    const phaseLabel = formatAgentPhase(agent, event.event);
    if (phaseLabel) {
      writer.writeLine(phaseLabel);
    }
    return;
  }
  if (event.event === "tool.started") {
    writer.writeLine(formatToolActivity("started", event.toolName ?? resolveToolName(event) ?? "unknown"));
    return;
  }
  if (event.event === "tool.awaiting_approval") {
    return;
  }
  if (event.event === "tool.completed") {
    const toolName = event.toolName ?? resolveToolName(event) ?? "unknown";
    if (event.status === "success") {
      writer.writeLine(formatToolActivity("completed", toolName));
      return;
    }
    writer.writeLine(`${toolName} (${event.status})`);
    return;
  }
  const label = event.event.replaceAll(".", " ");
  writer.writeLine(`${label} (${event.status})`);
}

function createUsageLineController(writer: TextOutputWriter, outputFormat: OutputFormat): UsageLineController {
  const interactiveTTY = outputFormat === "text" && (writer.isTTY?.() ?? false);
  let lineVisible = false;
  let lastMaterialPercent: number | undefined;
  let lastModelKey: string | undefined;
  let lastCompactionCount = 0;

  function clearLine(): void {
    if (!interactiveTTY || !lineVisible) {
      return;
    }
    writer.write("\r\u001b[2K");
    lineVisible = false;
  }

  return {
    handleEvent: (event) => {
      if (event.event !== "llm.usage.updated") {
        return false;
      }
      const parsed = LLMUsageTelemetryDetailsSchema.safeParse(event.details);
      if (!parsed.success) {
        return false;
      }
      const details = parsed.data;
      const percent = Math.round(details.usagePercent);
      const line = formatUsageLine(details);

      if (outputFormat === "json") {
        return false;
      }

      if (interactiveTTY) {
        writer.write(`\r${line}`);
        lineVisible = true;
        lastMaterialPercent = percent;
        lastModelKey = `${details.phase}:${details.model}`;
        lastCompactionCount = details.compactionCount;
        return true;
      }

      const modelKey = `${details.phase}:${details.model}`;
      const materialChange =
        lastModelKey !== modelKey ||
        lastMaterialPercent === undefined ||
        Math.abs(percent - lastMaterialPercent) >= 5 ||
        details.compactionCount !== lastCompactionCount ||
        details.stage === "compaction";
      if (materialChange) {
        writer.writeLine(line);
        lastMaterialPercent = percent;
        lastModelKey = modelKey;
        lastCompactionCount = details.compactionCount;
      }
      return true;
    },
    noteVisibleOutput: () => {
      clearLine();
    },
    finish: () => {
      clearLine();
    },
  };
}

function formatUsageLine(details: LLMUsageTelemetryDetails): string {
  if (details.stage === "response") {
    const fragments = [`Token usage: total=${formatTokenCount(details.totalTokens)}`, `input=${formatTokenCount(details.inputTokens)}`];
    if (details.cachedInputTokens > 0) {
      fragments.push(`(+ ${formatTokenCount(details.cachedInputTokens)} cached)`);
    }
    fragments.push(`output=${formatTokenCount(details.outputTokens)}`);
    if (details.reasoningOutputTokens > 0) {
      fragments.push(`(reasoning ${formatTokenCount(details.reasoningOutputTokens)})`);
    }
    return fragments.join(" ");
  }
  return `Context usage: ${Math.round(details.usagePercent)}% (${formatTokenCount(details.inputTokens)} / ${formatTokenCount(
    details.contextWindowTokens,
  )} tokens) · ${details.phase}:${details.model}`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}k`;
  }
  return `${value}`;
}

function summarizeStream(
  role: LLMStreamEvent["role"],
  buffered: string,
  metadata: { stepId?: string; stepTitle?: string; stepHasTools?: boolean },
  textMode: TextLLMRenderingMode,
): string[] {
  const parsed = safeJsonParse(buffered);
  if (parsed === undefined) {
    return [];
  }

  if (textMode === "assistant") {
    if (role !== "executor" || !isExecutorPayload(parsed)) {
      return [];
    }
    if (parsed.actionType === "final_response" && typeof parsed.finalResponse === "string") {
      if (metadata.stepHasTools) {
        return [];
      }
      return [parsed.finalResponse];
    }
    if (parsed.actionType === "clarification" && typeof parsed.clarificationQuestion === "string") {
      return [parsed.clarificationQuestion];
    }
    return [];
  }

  if (role === "analyzer" && isAnalyzerPayload(parsed)) {
    return [
      `Analyzer: ${parsed.objective}`,
      `Analyzer plan: ${parsed.plan.length} step(s), risk ${parsed.riskLevel}${parsed.assumptions.length > 0 ? `, assumptions ${parsed.assumptions.length}` : ""}`,
    ];
  }

  if (role === "executor" && isExecutorPayload(parsed)) {
    const stepId = metadata.stepId ?? parsed.stepId;
    const stepTitle = metadata.stepTitle;
    const stepLabel = [stepId ? `[${stepId}]` : undefined, stepTitle].filter((value): value is string => Boolean(value)).join(" ");
    const target = parsed.actionType === "tool_call" ? `${parsed.actionType} ${parsed.toolName}` : parsed.actionType;
    const result =
      parsed.actionType === "final_response"
        ? parsed.finalResponse
        : parsed.actionType === "clarification"
          ? parsed.clarificationQuestion
          : parsed.actionType === "handoff_to_evaluator"
            ? parsed.handoffReason
            : undefined;

    return [
      `Executor: ${stepLabel.length > 0 ? `${stepLabel} -> ` : ""}${target}`,
      ...(result ? [`Executor result: ${result}`] : []),
    ];
  }

  return [];
}

function extractAssistantPreview(buffer: string, stepHasTools?: boolean): string | undefined {
  if (stepHasTools) {
    return undefined;
  }
  return extractPartialJsonStringField(buffer, "finalResponse") ?? extractPartialJsonStringField(buffer, "clarificationQuestion");
}

function extractPartialJsonStringField(buffer: string, fieldName: string): string | undefined {
  const fieldIndex = buffer.indexOf(`"${fieldName}"`);
  if (fieldIndex === -1) {
    return undefined;
  }
  const colonIndex = buffer.indexOf(":", fieldIndex);
  if (colonIndex === -1) {
    return undefined;
  }
  let cursor = colonIndex + 1;
  while (cursor < buffer.length && /\s/.test(buffer[cursor] ?? "")) {
    cursor += 1;
  }
  if (buffer[cursor] !== "\"") {
    return undefined;
  }
  cursor += 1;

  let result = "";
  while (cursor < buffer.length) {
    const char = buffer[cursor];
    if (char === undefined) {
      break;
    }
    if (char === "\"") {
      return result;
    }
    if (char === "\\") {
      const escaped = buffer[cursor + 1];
      if (escaped === undefined) {
        return result;
      }
      if (escaped === "u") {
        const hex = buffer.slice(cursor + 2, cursor + 6);
        if (hex.length < 4 || /[^0-9a-f]/i.test(hex)) {
          return result;
        }
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        cursor += 6;
        continue;
      }
      result += decodeEscapedJsonChar(escaped);
      cursor += 2;
      continue;
    }
    result += char;
    cursor += 1;
  }
  return result;
}

function decodeEscapedJsonChar(value: string): string {
  switch (value) {
    case "\"":
      return "\"";
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return value;
  }
}

function safeJsonParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isAnalyzerPayload(
  value: unknown,
): value is { objective: string; assumptions: string[]; plan: unknown[]; riskLevel: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.objective === "string" &&
    Array.isArray(value.assumptions) &&
    Array.isArray(value.plan) &&
    typeof value.riskLevel === "string"
  );
}

function isExecutorPayload(
  value: unknown,
): value is {
  stepId: string;
  actionType: string;
  toolName?: string;
  finalResponse?: string;
  clarificationQuestion?: string;
  handoffReason?: string;
} {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.stepId === "string" && typeof value.actionType === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatRoleLabel(role: LLMStreamEvent["role"]): string {
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function resolveAgentName(event: TelemetryEvent): string | undefined {
  if (typeof event.agent === "string" && event.agent.length > 0) {
    return event.agent;
  }
  const detailAgent = event.details?.agent;
  return typeof detailAgent === "string" && detailAgent.length > 0 ? detailAgent : undefined;
}

function resolveToolName(event: TelemetryEvent): string | undefined {
  if (typeof event.toolName === "string" && event.toolName.length > 0) {
    return event.toolName;
  }
  const detailTool = event.details?.toolName;
  return typeof detailTool === "string" && detailTool.length > 0 ? detailTool : undefined;
}

function formatAgentPhase(agent: string, eventName: string): string | undefined {
  if (eventName !== "agent.started") {
    return undefined;
  }
  if (agent === "analyzer") {
    return undefined;
  }
  if (agent === "executor") {
    return undefined;
  }
  if (agent === "evaluator") {
    return undefined;
  }
  return `Working: ${agent}`;
}

function formatToolActivity(
  lifecycle: "started" | "awaiting_approval" | "completed",
  toolName: string,
): string {
  const label = describeTool(toolName);
  if (lifecycle === "started") {
    return label.started;
  }
  if (lifecycle === "awaiting_approval") {
    return label.approval;
  }
  return label.completed;
}

function describeTool(toolName: string): { started: string; approval: string; completed: string } {
  if (toolName === "web.search") {
    return {
      started: "Searching the web",
      approval: "Approval needed to search the web",
      completed: "Finished searching the web",
    };
  }
  if (toolName === "web.fetch") {
    return {
      started: "Fetching from the web",
      approval: "Approval needed for web access",
      completed: "Finished fetching from the web",
    };
  }
  if (toolName === "fs.list") {
    return {
      started: "Inspecting workspace",
      approval: "Approval needed to inspect workspace",
      completed: "Finished inspecting workspace",
    };
  }
  if (toolName === "fs.read") {
    return {
      started: "Reading file",
      approval: "Approval needed to read file",
      completed: "Finished reading file",
    };
  }
  if (toolName === "fs.write" || toolName === "patch.apply") {
    return {
      started: "Editing files",
      approval: "Approval needed to edit files",
      completed: "Finished editing files",
    };
  }
  if (toolName === "shell.exec" || toolName === "validation.run") {
    return {
      started: "Running command",
      approval: "Approval needed to run command",
      completed: "Finished running command",
    };
  }
  const genericLabel = humanizeToolName(toolName);
  return {
    started: `Using ${genericLabel}`,
    approval: `Approval needed to use ${genericLabel}`,
    completed: `Finished using ${genericLabel}`,
  };
}

function humanizeToolName(toolName: string): string {
  const normalized = toolName
    .replace(/^mcp\./, "")
    .split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll(/[-_]+/g, " "))
    .join(" ");
  return normalized.length > 0 ? normalized : "tool";
}

function shouldStreamLiveText(buffer: string): boolean {
  const trimmed = buffer.trimStart();
  if (trimmed.length === 0) {
    return false;
  }
  return !(trimmed.startsWith("{") || trimmed.startsWith("["));
}

function createWorkingIndicatorController(
  writer: TextOutputWriter,
  outputFormat: OutputFormat,
  options: {
    delayMs?: number;
    frameIntervalMs?: number;
  } = {},
): WorkingIndicatorController {
  if (outputFormat === "json") {
    return createNoopWorkingIndicatorController();
  }

  const green = "\u001b[32m";
  const dim = "\u001b[2m";
  const reset = "\u001b[39m";
  const resetAll = "\u001b[22m";
  const delayMs = options.delayMs ?? 200;
  const frameIntervalMs = options.frameIntervalMs ?? 350;
  const frames = buildWorkingIndicatorFrames({ green, dim, reset, resetAll });
  const interactiveTTY = writer.isTTY?.() ?? false;
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  let visibleOutputStarted = false;
  let finished = false;
  let lineVisible = false;
  let activityObserved = false;
  let staticLineRendered = false;

  function clearTimers(): void {
    if (activationTimer) {
      clearTimeout(activationTimer);
      activationTimer = undefined;
    }
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = undefined;
    }
  }

  function clearTransientLine(): void {
    if (!interactiveTTY || !lineVisible) {
      return;
    }
    writer.write("\r\u001b[2K");
    lineVisible = false;
  }

  function renderFrame(): void {
    writer.write(`\r${frames[frameIndex]}`);
    lineVisible = true;
    frameIndex = (frameIndex + 1) % frames.length;
  }

  function activateIndicator(): void {
    if (finished || visibleOutputStarted) {
      return;
    }
    if (!interactiveTTY) {
      if (!staticLineRendered) {
        writer.writeLine("Working...");
        staticLineRendered = true;
      }
      return;
    }
    renderFrame();
    frameTimer = setInterval(renderFrame, frameIntervalMs);
  }

  return {
    noteActivity: () => {
      if (finished || visibleOutputStarted || activityObserved) {
        return;
      }
      activityObserved = true;
      if (delayMs <= 0) {
        activateIndicator();
        return;
      }
      activationTimer = setTimeout(() => {
        activationTimer = undefined;
        activateIndicator();
      }, delayMs);
    },
    noteVisibleOutput: () => {
      if (finished) {
        return;
      }
      visibleOutputStarted = true;
      clearTimers();
      clearTransientLine();
    },
    finish: () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimers();
      clearTransientLine();
    },
  };
}

function createNoopWorkingIndicatorController(): WorkingIndicatorController {
  return {
    noteActivity: () => {},
    noteVisibleOutput: () => {},
    finish: () => {},
  };
}

function buildWorkingIndicatorFrames(colors: {
  green: string;
  dim: string;
  reset: string;
  resetAll: string;
}): string[] {
  const label = "Working...";
  return [...label].map((_, highlightIndex) =>
    [...label]
      .map((character, characterIndex) =>
        characterIndex === highlightIndex
          ? `${colors.green}${character}${colors.reset}`
          : `${colors.dim}${character}${colors.resetAll}`,
      )
      .join(""),
  );
}
