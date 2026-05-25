import type { Logger } from "pino";

import type { LLMClient, LLMStreamEvent } from "./llm/client.js";
import { createLLMClient } from "./llm/providers.js";
import { RunStore, createRunId } from "./memory/run-store.js";
import { PermissionPolicy } from "./policy/permissions.js";
import { MetricsCollector } from "./telemetry/metrics.js";
import { ToolRegistry } from "./tools/registry.js";
import { HarnessController, type RunResult } from "./harness/controller.js";
import type { RunRequest, Settings, TelemetryEvent } from "./schemas.js";

export interface OrchestratorOptions {
  onEvent?: (event: TelemetryEvent) => void | Promise<void>;
  onLLMEvent?: (event: LLMStreamEvent) => void | Promise<void>;
  llm?: LLMClient;
}

export class Orchestrator {
  public constructor(
    private readonly settings: Settings,
    private readonly logger: Logger,
    private readonly options: OrchestratorOptions = {},
  ) {}

  public async run(request: RunRequest): Promise<RunResult> {
    const runStore = new RunStore(this.settings.artifactDir);
    await runStore.init();
    const runId = createRunId();
    const artifactStore = runStore.createArtifactStore(runId);
    const tools = await ToolRegistry.create(this.settings);
    const llm = this.options.llm ?? createLLMClient(this.settings);
    const controller = new HarnessController({
      runStore,
      artifactStore,
      llm,
      tools,
      policy: new PermissionPolicy(this.settings),
      logger: this.logger,
      metrics: new MetricsCollector(),
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.onLLMEvent ? { onLLMEvent: this.options.onLLMEvent } : {}),
    });
    return controller.run(request);
  }

  public async recover(runId: string): Promise<RunResult["state"]> {
    const runStore = new RunStore(this.settings.artifactDir);
    const artifactStore = runStore.createArtifactStore(runId);
    const tools = await ToolRegistry.create(this.settings);
    const llm = this.options.llm ?? createLLMClient(this.settings);
    const controller = new HarnessController({
      runStore,
      artifactStore,
      llm,
      tools,
      policy: new PermissionPolicy(this.settings),
      logger: this.logger,
      metrics: new MetricsCollector(),
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.onLLMEvent ? { onLLMEvent: this.options.onLLMEvent } : {}),
    });
    return controller.recover();
  }

  public async resume(runId: string): Promise<RunResult> {
    const runStore = new RunStore(this.settings.artifactDir);
    const artifactStore = runStore.createArtifactStore(runId);
    const tools = await ToolRegistry.create(this.settings);
    const llm = this.options.llm ?? createLLMClient(this.settings);
    const controller = new HarnessController({
      runStore,
      artifactStore,
      llm,
      tools,
      policy: new PermissionPolicy(this.settings),
      logger: this.logger,
      metrics: new MetricsCollector(),
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.onLLMEvent ? { onLLMEvent: this.options.onLLMEvent } : {}),
    });
    return controller.resume();
  }
}
