import type { z } from "zod";

import type { AnalysisResult, EvaluationResult, ExecutionReport, ExecutorAction, RunRequest } from "../../src/schemas.js";
import { AnalysisResultSchema, EvaluationResultSchema, ExecutorActionSchema } from "../../src/schemas.js";
import type { LLMClient, LLMGenerateRequest, LLMGenerateResponse } from "../../src/llm/client.js";
import { renderPromptEnvelopeForTransport } from "../../src/llm/prompts.js";
import { LLMTokenCountSchema, type LLMTokenCount } from "../../src/schemas.js";

export class DeterministicTestLLMClient implements LLMClient {
  public constructor(private readonly model = "gpt-5.4-test") {}

  public async countTokens<T>(request: LLMGenerateRequest, _schema?: z.ZodType<T>): Promise<LLMTokenCount> {
    const transport = renderPromptEnvelopeForTransport(request.prompt, request.input);
    return LLMTokenCountSchema.parse({
      provider: "openai",
      model: this.model,
      inputTokens: Math.max(1, Math.ceil(transport.promptChars / 4)),
      contextWindowTokens: 128_000,
    });
  }

  public async generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>> {
    let object: unknown;
    switch (request.role) {
      case "analyzer":
        object = createAnalysisFromTask(request.input as RunRequest);
        break;
      case "executor":
        object = createExecutorAction(
          request.input as {
            analysis: AnalysisResult;
            step: AnalysisResult["plan"][number];
            observation: string;
            stepMemory?: {
              filesInspected?: string[];
            };
          },
        );
        break;
      case "evaluator":
        object = createEvaluationSkeleton(request.input as { analysis: AnalysisResult; execution: ExecutionReport });
        break;
    }

    const parsed = schema.parse(object);
    const rendered = JSON.stringify(parsed, null, 2);
    await request.stream?.onEvent?.({
      type: "response.created",
      data: {
        model: this.model,
      },
    });
    await request.stream?.onTextDelta?.(rendered);
    await request.stream?.onEvent?.({
      type: "response.completed",
      data: {
        response: {
          model: this.model,
          output_text: rendered,
        },
      },
    });
    return {
      object: parsed,
      model: this.model,
      promptChars: renderPromptEnvelopeForTransport(request.prompt, request.input).promptChars,
      inputTokens: Math.max(1, Math.ceil(renderPromptEnvelopeForTransport(request.prompt, request.input).promptChars / 4)),
      outputTokens: Math.max(1, Math.ceil(rendered.length / 4)),
      totalTokens:
        Math.max(1, Math.ceil(renderPromptEnvelopeForTransport(request.prompt, request.input).promptChars / 4)) +
        Math.max(1, Math.ceil(rendered.length / 4)),
      contextWindowTokens: 128_000,
      estimatedCostUsd: 0,
    };
  }

  public healthCheck(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({
      ok: true,
      message: `Deterministic test LLM is ready for model '${this.model}'.`,
    });
  }
}

function createAnalysisFromTask(request: RunRequest): AnalysisResult {
  const task = resolveTaskWithConversationContext(request);
  const createFileMatch = task.match(/create file\s+(.+?)\s+with content\s+([\s\S]+)/i);
  const appendMatch = task.match(/append\s+([\s\S]+)\s+to\s+(.+)/i);
  const normalizedTask = task.trim().toLowerCase();

  if (/^(hello|hi|hey|hello there|good morning|good afternoon|good evening)[!. ]*$/i.test(task.trim())) {
    return AnalysisResultSchema.parse({
      objective: task,
      assumptions: [],
      unknowns: [],
      successCriteria: ["A friendly assistant reply is produced."],
      plan: [
        {
          id: "respond",
          title: "Respond to user",
          description: "Reply directly to the user's greeting.",
          agent: "executor",
          toolNames: [],
          expectedOutput: "Friendly greeting reply",
          approvalRequired: false,
        },
      ],
      requiredTools: [],
      riskLevel: "low",
    });
  }

  if (/\bweather\b/.test(normalizedTask)) {
    return AnalysisResultSchema.parse({
      objective: task,
      assumptions: ["Current weather should be gathered from the web search tool."],
      unknowns: [],
      successCriteria: ["Current weather information is gathered.", "A concise weather reply is produced."],
      plan: [
        {
          id: "search-weather",
          title: "Search current weather",
          description: `Search the web for current weather details relevant to: ${task}`,
          agent: "executor",
          toolNames: ["web.search"],
          expectedOutput: "Fresh weather search results",
          approvalRequired: false,
        },
        {
          id: "respond-weather",
          title: "Respond to user",
          description: "Answer the user's weather question using the search results.",
          agent: "executor",
          toolNames: [],
          expectedOutput: "Weather answer",
          approvalRequired: false,
        },
      ],
      requiredTools: ["web.search"],
      riskLevel: "low",
    });
  }

  if (createFileMatch?.[1] && createFileMatch[2]) {
    const filePath = createFileMatch[1].trim();
    return AnalysisResultSchema.parse({
      objective: task,
      assumptions: ["The destination path is inside the configured workspace."],
      unknowns: [],
      successCriteria: [`File '${filePath}' exists with the requested content.`],
      plan: [
        {
          id: "inspect-workspace",
          title: "Inspect workspace",
          description: "Confirm the workspace is accessible before editing.",
          agent: "executor",
          toolNames: ["fs.list"],
          expectedOutput: "Directory listing",
          approvalRequired: false,
        },
        {
          id: "write-file",
          title: "Write file",
          description: `Create ${filePath} with the requested content.`,
          agent: "executor",
          toolNames: ["fs.write"],
          expectedOutput: `File ${filePath} written`,
          approvalRequired: false,
        },
        {
          id: "report-result",
          title: "Respond to user",
          description: "Confirm the file change to the user.",
          agent: "executor",
          toolNames: [],
          expectedOutput: "Concise completion message",
          approvalRequired: false,
        },
      ],
      requiredTools: ["fs.list", "fs.write"],
      riskLevel: "low",
    });
  }

  if (appendMatch?.[1] && appendMatch[2]) {
    const filePath = appendMatch[2].trim();
    return AnalysisResultSchema.parse({
      objective: task,
      assumptions: ["The target file already exists."],
      unknowns: [],
      successCriteria: [`File '${filePath}' contains the appended content.`],
      plan: [
        {
          id: "read-file",
          title: "Read target file",
          description: `Read ${filePath} to prepare a safe patch.`,
          agent: "executor",
          toolNames: ["fs.read"],
          expectedOutput: `Current content of ${filePath}`,
          approvalRequired: false,
        },
        {
          id: "patch-file",
          title: "Patch target file",
          description: `Append the requested content to ${filePath}.`,
          agent: "executor",
          toolNames: ["fs.write"],
          expectedOutput: `Updated ${filePath}`,
          approvalRequired: false,
        },
        {
          id: "report-result",
          title: "Respond to user",
          description: "Confirm the file update to the user.",
          agent: "executor",
          toolNames: [],
          expectedOutput: "Concise completion message",
          approvalRequired: false,
        },
      ],
      requiredTools: ["fs.read", "fs.write"],
      riskLevel: "low",
    });
  }

  return AnalysisResultSchema.parse({
    objective: task,
    assumptions: ["The task may require manual planning beyond the built-in deterministic executor."],
    unknowns: ["Exact workspace changes required by the request."],
    successCriteria: ["Relevant workspace inspection completed.", "A concrete next action is identified."],
    plan: [
      {
        id: "inspect-workspace",
        title: "Inspect workspace",
        description: "List workspace files to gather context.",
        agent: "executor",
        toolNames: ["fs.list"],
        expectedOutput: "Workspace listing",
        approvalRequired: false,
      },
    ],
    requiredTools: ["fs.list"],
    riskLevel: "low",
  });
}

function resolveTaskWithConversationContext(request: RunRequest): string {
  const task = request.task.trim();
  if (!/\b(that|the)\s+file\b/i.test(task)) {
    return task;
  }
  const referencedFile = request.conversationContext?.recentTurns
    .slice()
    .reverse()
    .map((turn) => extractReferencedFile(turn.content) ?? extractReferencedFile(turn.summary ?? ""))
    .find((value): value is string => typeof value === "string");
  if (!referencedFile) {
    return task;
  }
  return task.replaceAll(/\b(that|the)\s+file\b/gi, referencedFile);
}

function extractReferencedFile(value: string): string | undefined {
  const createMatch = value.match(/create file\s+(.+?)\s+with content/i);
  if (createMatch?.[1]) {
    return createMatch[1].trim();
  }
  const appendMatch = value.match(/append\s+[\s\S]+\s+to\s+(.+)/i);
  if (appendMatch?.[1]) {
    return appendMatch[1].trim();
  }
  return undefined;
}

function createExecutorAction(input: {
  analysis: AnalysisResult;
  step: AnalysisResult["plan"][number];
  observation: string;
  stepMemory?: {
    filesInspected?: string[];
  };
}): ExecutorAction {
  const task = input.analysis.objective.trim();
  const step = input.step;
  const firstTool = step.toolNames[0];
  if (/(completed successfully|applied successfully|prepared in dry-run mode|no-op)/i.test(input.observation)) {
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation: input.observation,
      actionType: "final_response",
      rationaleSummary: "The required tool work for this step has completed successfully.",
      finalResponse: `Completed step '${step.title}'.`,
    });
  }
  if (step.toolNames.length === 0) {
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation: input.observation,
      actionType: "final_response",
      rationaleSummary: "This step is a direct assistant reply with no tool use.",
      finalResponse: buildDirectResponse(task, step, input.observation),
    });
  }
  if (!firstTool) {
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation: input.observation,
      actionType: "clarification",
      rationaleSummary: "The plan step has no executable tools.",
      clarificationQuestion: `No tool is available for step '${step.title}'.`,
    });
  }

  if (firstTool === "fs.list") {
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation: input.observation,
      actionType: "tool_call",
      toolName: "fs.list",
      toolInput: toToolInputEntries({ path: ".", recursive: false }),
      rationaleSummary: "Inspect the workspace before editing.",
    });
  }

  if (firstTool === "fs.read") {
    const match = task.match(/to\s+(.+)/i) ?? task.match(/file\s+(.+?)\s+/i);
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation: input.observation,
      actionType: "tool_call",
      toolName: "fs.read",
      toolInput: toToolInputEntries({ path: match?.[1]?.trim() ?? "." }),
      rationaleSummary: "Read the target file before preparing a safe edit.",
    });
  }

  if (firstTool === "fs.write") {
    const createMatch = task.match(/create file\s+(.+?)\s+with content\s+([\s\S]+)/i);
    if (createMatch?.[1] && createMatch[2]) {
      return ExecutorActionSchema.parse({
        stepId: step.id,
        observation: input.observation,
        actionType: "patch_proposal",
        patch: {
          path: createMatch[1].trim(),
          reason: `Create ${createMatch[1].trim()} with the requested content.`,
          updatedContent: createMatch[2],
          createIfMissing: true,
        },
        rationaleSummary: "Prefer a patch proposal before mutating the workspace.",
      });
    }
    const appendMatch = task.match(/append\s+([\s\S]+)\s+to\s+(.+)/i);
    if (appendMatch?.[1] && appendMatch[2]) {
      return ExecutorActionSchema.parse({
        stepId: step.id,
        observation: input.observation,
        actionType: "patch_proposal",
        patch: {
          path: appendMatch[2].trim(),
          reason: `Append requested content to ${appendMatch[2].trim()}.`,
          updatedContent: `${inferCurrentContent(input.stepMemory?.filesInspected ?? [])}${appendMatch[1]}`,
          createIfMissing: false,
        },
        rationaleSummary: "Use a patch proposal to append content safely.",
      });
    }
  }

  if (firstTool === "web.search") {
    if (input.observation.startsWith("Found ")) {
      return ExecutorActionSchema.parse({
        stepId: step.id,
        observation: input.observation,
        actionType: "final_response",
        rationaleSummary: "The current-information search already succeeded for this step.",
        finalResponse: input.observation,
      });
    }
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation: input.observation,
      actionType: "tool_call",
      toolName: "web.search",
      toolInput: toToolInputEntries({
        query: task,
        maxResults: 5,
      }),
      rationaleSummary: "Use the registered web search tool for current information.",
    });
  }

  return ExecutorActionSchema.parse({
    stepId: step.id,
    observation: input.observation,
    actionType: "tool_call",
    toolName: firstTool,
    rationaleSummary: "Use the first approved tool for the current plan step.",
  });
}

function inferCurrentContent(inputs: string[]): string {
  const latest = inputs.at(-1);
  if (!latest) {
    return "";
  }
  try {
    const parsed = JSON.parse(latest) as { content?: string };
    return parsed.content ?? "";
  } catch {
    return "";
  }
}

function toToolInputEntries(input: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>) {
  return Object.entries(input).map(([key, value]) => ({ key, value }));
}

function buildDirectResponse(task: string, step: AnalysisResult["plan"][number], observation: string): string {
  const trimmedTask = task.trim();
  if (/^(hello|hi|hey|hello there|good morning|good afternoon|good evening)[!. ]*$/i.test(trimmedTask)) {
    return "Hello! How can I help today?";
  }
  if (step.id === "respond-weather") {
    return observation.startsWith("Found ") ? observation : `I couldn't verify the latest weather details yet. ${observation}`;
  }
  const createFileMatch = trimmedTask.match(/create file\s+(.+?)\s+with content\s+([\s\S]+)/i);
  if (createFileMatch?.[1]) {
    return `Created ${createFileMatch[1].trim()} with the requested content.`;
  }
  const appendMatch = trimmedTask.match(/append\s+([\s\S]+)\s+to\s+(.+)/i);
  if (appendMatch?.[2]) {
    return `Updated ${appendMatch[2].trim()} with the requested append.`;
  }
  return "Done.";
}

function createEvaluationSkeleton(input: { analysis: AnalysisResult; execution: ExecutionReport }): EvaluationResult {
  const passedCriteria = input.execution.blockers.length === 0 ? input.analysis.successCriteria : [];
  return EvaluationResultSchema.parse({
    status: input.execution.blockers.length === 0 ? "pass" : "needs_revision",
    passedCriteria,
    failedCriteria: input.execution.blockers.length === 0 ? [] : input.analysis.successCriteria,
    requiredRevisions: input.execution.blockers,
    validationCommands: [],
    validationDecisions: [],
    productionReadinessNotes: input.execution.blockers.length === 0 ? [] : ["Execution reported blockers."],
  });
}
