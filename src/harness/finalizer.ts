import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { ArtifactStore } from "../memory/artifact-store.js";
import type { AnalysisResult, EvaluationResult, ExecutionReport, HarnessRunState, RunRequest } from "../schemas.js";

export class Finalizer {
  public constructor(private readonly artifactStore: ArtifactStore) {}

  public async writeFinalReport(input: {
    request: RunRequest;
    state: HarnessRunState;
    analysis: AnalysisResult | undefined;
    execution: ExecutionReport | undefined;
    evaluation: EvaluationResult | undefined;
  }): Promise<string> {
    await this.writeCombinedDiffArtifact();
    const promptMetadata = await this.readPromptEnvelopeArtifacts();
    const report = [
      `# Run ${input.state.runId}`,
      "",
      `- Status: ${input.state.status}`,
      `- Phase: ${input.state.phase}`,
      `- Iteration: ${input.state.iteration}`,
      "",
      "## Task",
      "",
      input.request.task,
      "",
      "## Analysis",
      "",
      input.analysis ? JSON.stringify(input.analysis, null, 2) : "Not available.",
      "",
      "## Selected Skills",
      "",
      input.request.selectedSkills.length > 0 ? JSON.stringify(input.request.selectedSkills, null, 2) : "None.",
      "",
      "## Prompt Attestation",
      "",
      promptMetadata.length > 0 ? JSON.stringify(promptMetadata, null, 2) : "Not available.",
      "",
      "## Execution",
      "",
      input.execution ? JSON.stringify(input.execution, null, 2) : "Not available.",
      "",
      "## Evaluation",
      "",
      input.evaluation ? JSON.stringify(input.evaluation, null, 2) : "Not available.",
      "",
    ].join("\n");
    return this.artifactStore.writeText("final-report.md", report);
  }

  private async writeCombinedDiffArtifact(): Promise<void> {
    const files = await readdir(this.artifactStore.artifactsDirectory);
    const diffFiles = files.filter((file) => file.endsWith(".patch")).sort();
    if (diffFiles.length === 0) {
      return;
    }
    const chunks: string[] = [];
    for (const file of diffFiles) {
      const absolute = path.join(this.artifactStore.artifactsDirectory, file);
      const content = await readFile(absolute, "utf8");
      chunks.push(`# ${file}\n${content}`);
    }
    await this.artifactStore.writeText("diff.patch", chunks.join("\n\n"));
  }

  private async readPromptEnvelopeArtifacts(): Promise<unknown[]> {
    const files = await readdir(this.artifactStore.runDirectory);
    const promptFiles = files.filter((file) => file.startsWith("prompt-envelope-") && file.endsWith(".json")).sort();
    const values: unknown[] = [];
    for (const file of promptFiles) {
      const raw = await readFile(path.join(this.artifactStore.runDirectory, file), "utf8");
      values.push(JSON.parse(raw));
    }
    return values;
  }
}
