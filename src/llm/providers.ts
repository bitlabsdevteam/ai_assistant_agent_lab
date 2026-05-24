import type { z } from "zod";

import { AppError } from "../errors.js";
import type { AnalysisResult, EvaluationResult, ExecutionReport, ExecutorAction, RunRequest, Settings } from "../schemas.js";
import { AnalysisResultSchema, EvaluationResultSchema, ExecutorActionSchema } from "../schemas.js";
import type { LLMClient, LLMGenerateRequest, LLMGenerateResponse } from "./client.js";
import { OpenAIResponsesClient } from "./openai.js";
import { listResolvedLLMConfigs, resolveLLMConfigForRole, type ResolvedLLMConfig } from "./routing.js";

export class MockLLMClient implements LLMClient {
  public constructor(private readonly model: string) {}

  public generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>> {
    let object: unknown;
    switch (request.role) {
      case "analyzer":
        object = createAnalysisFromTask(request.input as RunRequest);
        break;
      case "executor":
        object = createExecutorAction(request.input as MockExecutorInput);
        break;
      case "evaluator":
        object = createEvaluationSkeleton(request.input as { analysis: AnalysisResult; execution: ExecutionReport });
        break;
    }
    const parsed = schema.parse(object);
    return Promise.resolve({
      object: parsed,
      model: this.model,
      promptChars: request.prompt.length,
      estimatedCostUsd: 0,
    });
  }

  public healthCheck(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({ ok: true, message: "Mock LLM provider is ready." });
  }
}

export class UnsupportedLLMClient implements LLMClient {
  public constructor(private readonly provider: string, private readonly model: string) {}

  public generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>> {
    void request;
    void schema;
    return Promise.reject(
      new AppError(
        "LLM_ERROR",
        `Provider '${this.provider}' is configured but no adapter is implemented yet for model '${this.model}'.`,
      ),
    );
  }

  public healthCheck(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({
      ok: false,
      message: `Provider '${this.provider}' is not implemented in this build.`,
    });
  }
}

export class RoutedLLMClient implements LLMClient {
  private readonly clients = new Map<string, LLMClient>();

  public constructor(
    private readonly settings: Settings,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  public generateObject<T>(request: LLMGenerateRequest, schema: z.ZodType<T>): Promise<LLMGenerateResponse<T>> {
    return this.getClientForRole(request.role).generateObject(request, schema);
  }

  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const resolved = listResolvedLLMConfigs(this.settings);
    const uniqueByKey = new Map<string, { roles: string[]; config: ResolvedLLMConfig }>();
    for (const item of resolved) {
      const key = stableConfigKey(item.config);
      const existing = uniqueByKey.get(key);
      if (existing) {
        existing.roles.push(item.role);
        continue;
      }
      uniqueByKey.set(key, {
        roles: [item.role],
        config: item.config,
      });
    }

    if (uniqueByKey.size === 1) {
      const only = uniqueByKey.values().next().value;
      if (!only) {
        return { ok: false, message: "No LLM routes configured." };
      }
      return this.getClientForConfig(only.config).healthCheck();
    }

    const results = await Promise.all(
      [...uniqueByKey.values()].map(async (item) => ({
        roles: item.roles,
        result: await this.getClientForConfig(item.config).healthCheck(),
      })),
    );

    return {
      ok: results.every((item) => item.result.ok),
      message: results
        .map((item) => `${item.roles.join(",")}: ${item.result.message}`)
        .join(" | "),
    };
  }

  private getClientForRole(role: LLMGenerateRequest["role"]): LLMClient {
    return this.getClientForConfig(resolveLLMConfigForRole(this.settings, role));
  }

  private getClientForConfig(config: ResolvedLLMConfig): LLMClient {
    const key = stableConfigKey(config);
    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }
    const client = createProviderClient(config, this.env);
    this.clients.set(key, client);
    return client;
  }
}

export function createLLMClient(settings: Settings, env: NodeJS.ProcessEnv = process.env): LLMClient {
  return new RoutedLLMClient(settings, env);
}

function createProviderClient(config: ResolvedLLMConfig, env: NodeJS.ProcessEnv): LLMClient {
  if (config.provider === "mock") {
    return new MockLLMClient(config.model);
  }
  if (config.provider === "openai") {
    return new OpenAIResponsesClient(config, env);
  }
  return new UnsupportedLLMClient(config.provider, config.model);
}

function stableConfigKey(config: ResolvedLLMConfig): string {
  return JSON.stringify({
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.organization ? { organization: config.organization } : {}),
    ...(config.project ? { project: config.project } : {}),
  });
}

function createAnalysisFromTask(request: RunRequest): AnalysisResult {
  const task = request.task.trim();
  const createFileMatch = task.match(/create file\s+(.+?)\s+with content\s+([\s\S]+)/i);
  const appendMatch = task.match(/append\s+([\s\S]+)\s+to\s+(.+)/i);

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

interface MockExecutorInput {
  analysis: AnalysisResult;
  step: AnalysisResult["plan"][number];
  observation: string;
}

function createExecutorAction(input: MockExecutorInput): ExecutorAction {
  const task = input.analysis.objective.trim();
  const step = input.step;
  const firstTool = step.toolNames[0];
  if (input.observation.toLowerCase().includes("completed successfully")) {
    return ExecutorActionSchema.parse({
      stepId: step.id,
      observation: input.observation,
      actionType: "final_response",
      rationaleSummary: "The required tool work for this step has completed successfully.",
      finalResponse: `Completed step '${step.title}'.`,
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
      toolInput: { path: ".", recursive: false },
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
      toolInput: { path: match?.[1]?.trim() ?? "." },
      rationaleSummary: "Read the target file before preparing a safe edit.",
    });
  }

  if (firstTool === "fs.write") {
    const createMatch = task.match(/create file\s+(.+?)\s+with content\s+([\s\S]+)/i);
    if (createMatch?.[1] && createMatch[2]) {
      return ExecutorActionSchema.parse({
        stepId: step.id,
        observation: input.observation,
        actionType: "tool_call",
        toolName: "fs.write",
        toolInput: {
          path: createMatch[1].trim(),
          content: createMatch[2],
          createDirectories: true,
        },
        rationaleSummary: "Write the requested file content directly.",
      });
    }
    const appendMatch = task.match(/append\s+([\s\S]+)\s+to\s+(.+)/i);
    if (appendMatch?.[1] && appendMatch[2]) {
      return ExecutorActionSchema.parse({
        stepId: step.id,
        observation: input.observation,
        actionType: "tool_call",
        toolName: "fs.write",
        toolInput: {
          path: appendMatch[2].trim(),
          createDirectories: true,
        },
        rationaleSummary: "Write the updated file content after reading the target file.",
      });
    }
  }

  return ExecutorActionSchema.parse({
    stepId: step.id,
    observation: input.observation,
    actionType: "tool_call",
    toolName: firstTool,
    rationaleSummary: "Use the first approved tool for the current plan step.",
  });
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
