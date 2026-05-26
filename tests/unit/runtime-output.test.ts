import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLLMStreamRenderer,
  createRuntimeTextRenderer,
  renderHarnessEvent,
  type TextOutputWriter,
} from "../../src/rendering/runtime-output.js";

class BufferingWriter implements TextOutputWriter {
  public readonly lines: string[] = [];

  public constructor(private readonly tty = false) {}

  public write(text: string): void {
    this.lines.push(text);
  }

  public writeLine(line: string): void {
    this.lines.push(line);
  }

  public isTTY(): boolean {
    return this.tty;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime output rendering", () => {
  it("starts the working indicator after a short delay when work begins without visible output", () => {
    vi.useFakeTimers();
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    vi.advanceTimersByTime(199);

    expect(writer.lines).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(writer.lines).toEqual([
      "\r\u001b[32mW\u001b[39m\u001b[2mo\u001b[22m\u001b[2mr\u001b[22m\u001b[2mk\u001b[22m\u001b[2mi\u001b[22m\u001b[2mn\u001b[22m\u001b[2mg\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m",
    ]);
  });

  it("renders the working indicator immediately when delay is zero", () => {
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text", {
      workingIndicator: {
        delayMs: 0,
      },
    });

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });

    expect(writer.lines).toEqual([
      "\r\u001b[32mW\u001b[39m\u001b[2mo\u001b[22m\u001b[2mr\u001b[22m\u001b[2mk\u001b[22m\u001b[2mi\u001b[22m\u001b[2mn\u001b[22m\u001b[2mg\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m",
    ]);
  });

  it("animates the working indicator from left to right in interactive terminals", () => {
    vi.useFakeTimers();
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    vi.advanceTimersByTime(200);
    vi.advanceTimersByTime(350);

    expect(writer.lines).toEqual([
      "\r\u001b[32mW\u001b[39m\u001b[2mo\u001b[22m\u001b[2mr\u001b[22m\u001b[2mk\u001b[22m\u001b[2mi\u001b[22m\u001b[2mn\u001b[22m\u001b[2mg\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m",
      "\r\u001b[2mW\u001b[22m\u001b[32mo\u001b[39m\u001b[2mr\u001b[22m\u001b[2mk\u001b[22m\u001b[2mi\u001b[22m\u001b[2mn\u001b[22m\u001b[2mg\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m",
    ]);
  });

  it("stops the working indicator when tool progress becomes visible", () => {
    vi.useFakeTimers();
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    vi.advanceTimersByTime(200);
    renderer.onEvent({
      runId: "run-1",
      event: "tool.started",
      status: "running",
      timestamp: new Date().toISOString(),
      toolName: "web.search",
    });
    vi.advanceTimersByTime(1_000);

    expect(writer.lines).toEqual([
      "\r\u001b[32mW\u001b[39m\u001b[2mo\u001b[22m\u001b[2mr\u001b[22m\u001b[2mk\u001b[22m\u001b[2mi\u001b[22m\u001b[2mn\u001b[22m\u001b[2mg\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m",
      "\r\u001b[2K",
      "Searching the web",
    ]);
  });

  it("stops the working indicator when assistant text starts streaming", () => {
    vi.useFakeTimers();
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text", { textMode: "assistant" });

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    vi.advanceTimersByTime(200);
    renderer.onLLMEvent({
      role: "executor",
      type: "response.output_text.delta",
      delta: '{"stepId":"respond","actionType":"final_response","rationaleSummary":"Reply directly.","finalResponse":"Hello',
      stepId: "respond",
      stepTitle: "Respond",
      stepHasTools: false,
    });

    expect(writer.lines).toEqual([
      "\r\u001b[32mW\u001b[39m\u001b[2mo\u001b[22m\u001b[2mr\u001b[22m\u001b[2mk\u001b[22m\u001b[2mi\u001b[22m\u001b[2mn\u001b[22m\u001b[2mg\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m",
      "\r\u001b[2K",
      "Hello",
    ]);
  });

  it("does not emit the working indicator in json mode", () => {
    vi.useFakeTimers();
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "json");

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: "2026-05-25T00:00:00.000Z",
    });
    vi.advanceTimersByTime(1_000);

    expect(writer.lines).toEqual([
      JSON.stringify({
        type: "harness.event",
        runId: "run-1",
        event: "harness.run_started",
        status: "success",
        timestamp: "2026-05-25T00:00:00.000Z",
      }),
    ]);
  });

  it("emits only one static working line when terminal redraw is not interactive", () => {
    vi.useFakeTimers();
    const writer = new BufferingWriter(false);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    vi.advanceTimersByTime(5_000);

    expect(writer.lines).toEqual(["Working..."]);
  });

  it("cleans up the transient working line on finish", () => {
    vi.useFakeTimers();
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    vi.advanceTimersByTime(200);
    renderer.finish();
    vi.advanceTimersByTime(1_000);

    expect(writer.lines).toEqual([
      "\r\u001b[32mW\u001b[39m\u001b[2mo\u001b[22m\u001b[2mr\u001b[22m\u001b[2mk\u001b[22m\u001b[2mi\u001b[22m\u001b[2mn\u001b[22m\u001b[2mg\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m\u001b[2m.\u001b[22m",
      "\r\u001b[2K",
    ]);
  });

  it("renders a transient token usage line in interactive terminals", () => {
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "llm.usage.updated",
      status: "success",
      timestamp: new Date().toISOString(),
      details: {
        phase: "executor",
        model: "gpt-5.4",
        provider: "openai",
        contextWindowTokens: 128_000,
        inputTokens: 60_000,
        outputTokens: 0,
        totalTokens: 60_000,
        usagePercent: 46.9,
        peakUsagePercent: 46.9,
        compactionCount: 1,
        compactionMode: "compact",
        stage: "compaction",
      },
    });

    expect(writer.lines).toEqual(["\rContext usage: 47% (60k / 128k tokens) · executor:gpt-5.4"]);
  });

  it("renders detailed response-stage token usage when available", () => {
    const writer = new BufferingWriter(true);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "llm.usage.updated",
      status: "success",
      timestamp: new Date().toISOString(),
      details: {
        phase: "executor",
        model: "gpt-5.4",
        provider: "openai",
        contextWindowTokens: 128_000,
        inputTokens: 53_698,
        outputTokens: 7_354,
        totalTokens: 61_052,
        cachedInputTokens: 644_352,
        reasoningOutputTokens: 2_080,
        usagePercent: 41.9,
        peakUsagePercent: 41.9,
        compactionCount: 0,
        compactionMode: "full",
        stage: "response",
      },
    });

    expect(writer.lines).toEqual(["\rToken usage: total=61.1k input=53.7k (+ 644.4k cached) output=7.4k (reasoning 2.1k)"]);
  });

  it("prints material token usage updates once in non-tty mode", () => {
    const writer = new BufferingWriter(false);
    const renderer = createRuntimeTextRenderer(writer, "text");

    renderer.onEvent({
      runId: "run-1",
      event: "llm.usage.updated",
      status: "success",
      timestamp: new Date().toISOString(),
      details: {
        phase: "analyzer",
        model: "gpt-5.4",
        provider: "openai",
        contextWindowTokens: 128_000,
        inputTokens: 10_000,
        outputTokens: 0,
        totalTokens: 10_000,
        usagePercent: 7.8,
        peakUsagePercent: 7.8,
        compactionCount: 0,
        compactionMode: "full",
        stage: "preflight",
      },
    });
    renderer.onEvent({
      runId: "run-1",
      event: "llm.usage.updated",
      status: "success",
      timestamp: new Date().toISOString(),
      details: {
        phase: "analyzer",
        model: "gpt-5.4",
        provider: "openai",
        contextWindowTokens: 128_000,
        inputTokens: 11_000,
        outputTokens: 0,
        totalTokens: 11_000,
        usagePercent: 8.6,
        peakUsagePercent: 8.6,
        compactionCount: 0,
        compactionMode: "full",
        stage: "preflight",
      },
    });

    expect(writer.lines).toEqual(["Context usage: 8% (10k / 128k tokens) · analyzer:gpt-5.4"]);
  });

  it("suppresses checkpoint events in text mode", () => {
    const writer = new BufferingWriter();

    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "harness.checkpoint_written",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "harness.run_started",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "harness.resumed",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "evaluation.passed",
      status: "pass",
      timestamp: new Date().toISOString(),
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "run.completed",
      status: "success",
      timestamp: new Date().toISOString(),
    });

    expect(writer.lines).toEqual([]);
  });

  it("suppresses generic agent-phase chrome in text mode", () => {
    const writer = new BufferingWriter();

    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "agent.started",
      status: "running",
      timestamp: new Date().toISOString(),
      details: {
        agent: "analyzer",
      },
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "harness.awaiting_approval",
      status: "pending",
      timestamp: new Date().toISOString(),
    });

    expect(writer.lines).toEqual([]);
  });

  it("renders tool progress in text mode without duplicate approval lines", () => {
    const writer = new BufferingWriter();

    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "tool.started",
      status: "running",
      timestamp: new Date().toISOString(),
      toolName: "web.search",
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "tool.awaiting_approval",
      status: "pending",
      timestamp: new Date().toISOString(),
      toolName: "web.search",
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "tool.completed",
      status: "success",
      timestamp: new Date().toISOString(),
      toolName: "web.search",
    });

    expect(writer.lines).toEqual([
      "Searching the web",
      "Finished searching the web",
    ]);
  });

  it("humanizes fallback tool progress labels in text mode", () => {
    const writer = new BufferingWriter();

    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "tool.started",
      status: "running",
      timestamp: new Date().toISOString(),
      toolName: "mcp.perplexity.deep_research",
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "tool.awaiting_approval",
      status: "pending",
      timestamp: new Date().toISOString(),
      toolName: "mcp.perplexity.deep_research",
    });
    renderHarnessEvent(writer, "text", {
      runId: "run-1",
      event: "tool.completed",
      status: "success",
      timestamp: new Date().toISOString(),
      toolName: "mcp.perplexity.deep_research",
    });

    expect(writer.lines).toEqual([
      "Using perplexity deep research",
      "Finished using perplexity deep research",
    ]);
  });

  it("emits full telemetry in json mode", () => {
    const writer = new BufferingWriter();

    renderHarnessEvent(writer, "json", {
      runId: "run-1",
      event: "harness.checkpoint_written",
      status: "success",
      timestamp: "2026-05-25T00:00:00.000Z",
      details: {
        checkpointId: "cp-1",
      },
    });

    expect(writer.lines).toEqual([
      JSON.stringify({
        type: "harness.event",
        runId: "run-1",
        event: "harness.checkpoint_written",
        status: "success",
        timestamp: "2026-05-25T00:00:00.000Z",
        details: {
          checkpointId: "cp-1",
        },
      }),
    ]);
  });

  it("renders concise analyzer and executor summaries in text mode", () => {
    const writer = new BufferingWriter();
    const renderer = createLLMStreamRenderer(writer, "text");

    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.output_text.delta",
      delta: JSON.stringify({
        objective: "Create file hello.txt with content hello",
        assumptions: ["The workspace is writable."],
        unknowns: [],
        successCriteria: ["File exists."],
        plan: [{ id: "write-file" }],
        requiredTools: ["fs.write"],
        riskLevel: "low",
      }),
    });
    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.completed",
    });
    renderer.onLLMEvent({
      role: "executor",
      type: "response.output_text.delta",
      delta: JSON.stringify({
        stepId: "write-file",
        observation: "Workspace inspected.",
        actionType: "tool_call",
        toolName: "fs.write",
        rationaleSummary: "Write the file.",
      }),
      stepId: "write-file",
      stepTitle: "Write file",
    });
    renderer.onLLMEvent({
      role: "executor",
      type: "response.completed",
      stepId: "write-file",
      stepTitle: "Write file",
    });

    expect(writer.lines).toEqual([
      "Analyzer: Create file hello.txt with content hello",
      "Analyzer plan: 1 step(s), risk low, assumptions 1",
      "Executor: [write-file] Write file -> tool_call fs.write",
    ]);
  });

  it("flushes structured summaries when output text completes before the full response event", () => {
    const writer = new BufferingWriter();
    const renderer = createLLMStreamRenderer(writer, "text");

    renderer.onLLMEvent({
      role: "executor",
      type: "response.output_text.delta",
      delta: JSON.stringify({
        stepId: "write-file",
        observation: "Workspace inspected.",
        actionType: "patch_proposal",
        rationaleSummary: "Apply a minimal edit.",
      }),
      stepId: "write-file",
      stepTitle: "Write file",
    });
    renderer.onLLMEvent({
      role: "executor",
      type: "response.output_text.done",
      stepId: "write-file",
      stepTitle: "Write file",
    });

    expect(writer.lines).toEqual(["Executor: [write-file] Write file -> patch_proposal"]);
  });

  it("streams plain-text deltas immediately in text mode", () => {
    const writer = new BufferingWriter();
    const renderer = createLLMStreamRenderer(writer, "text");

    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.output_text.delta",
      delta: "Thinking",
    });
    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.output_text.delta",
      delta: " out loud",
    });
    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.output_text.done",
    });

    expect(writer.lines.join("")).toBe("Analyzer: Thinking out loud\n");
  });

  it("falls back to a buffered raw block for malformed partial content", () => {
    const writer = new BufferingWriter();
    const renderer = createLLMStreamRenderer(writer, "text");

    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.output_text.delta",
      delta: "{\"objective\":",
    });
    renderer.finish();

    expect(writer.lines).toEqual([
      "Analyzer output:",
      "{\"objective\":",
    ]);
  });

  it("streams only assistant-facing executor final responses in assistant text mode", () => {
    const writer = new BufferingWriter();
    const renderer = createLLMStreamRenderer(writer, "text", { textMode: "assistant" });

    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.output_text.delta",
      delta: JSON.stringify({
        objective: "Say hello",
        assumptions: [],
        unknowns: [],
        successCriteria: [],
        plan: [{ id: "respond" }],
        requiredTools: [],
        riskLevel: "low",
      }),
    });
    renderer.onLLMEvent({
      role: "analyzer",
      type: "response.completed",
    });
    renderer.onLLMEvent({
      role: "executor",
      type: "response.output_text.delta",
      delta: JSON.stringify({
        stepId: "respond",
        observation: "Greeting classified.",
        actionType: "final_response",
        rationaleSummary: "Reply directly.",
        finalResponse: "Hello! How can I help today?",
      }),
      stepId: "respond",
      stepTitle: "Respond to user",
    });
    renderer.onLLMEvent({
      role: "executor",
      type: "response.completed",
      stepId: "respond",
      stepTitle: "Respond to user",
    });

    expect(writer.lines.join("")).toBe("Hello! How can I help today?\n");
    expect(renderer.hasStreamedAssistantContent()).toBe(true);
  });

  it("streams assistant responses incrementally from partial executor JSON", () => {
    const writer = new BufferingWriter();
    const renderer = createLLMStreamRenderer(writer, "text", { textMode: "assistant" });

    renderer.onLLMEvent({
      role: "executor",
      type: "response.output_text.delta",
      delta: '{"stepId":"respond","actionType":"final_response","rationaleSummary":"Reply directly.","finalResponse":"Hello',
      stepId: "respond",
      stepTitle: "Respond to user",
      stepHasTools: false,
    });
    renderer.onLLMEvent({
      role: "executor",
      type: "response.output_text.delta",
      delta: ' there!"}',
      stepId: "respond",
      stepTitle: "Respond to user",
      stepHasTools: false,
    });
    renderer.onLLMEvent({
      role: "executor",
      type: "response.completed",
      stepId: "respond",
      stepTitle: "Respond to user",
      stepHasTools: false,
    });

    expect(writer.lines.join("")).toBe("Hello there!\n");
    expect(renderer.hasStreamedAssistantContent()).toBe(true);
  });
});
