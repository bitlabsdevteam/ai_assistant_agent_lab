import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../errors.js";

export class ArtifactStore {
  public readonly runDirectory: string;
  public readonly checkpointsDirectory: string;
  public readonly artifactsDirectory: string;

  public constructor(
    private readonly artifactBaseDir: string,
    public readonly runId: string,
  ) {
    this.runDirectory = path.join(artifactBaseDir, runId);
    this.checkpointsDirectory = path.join(this.runDirectory, "checkpoints");
    this.artifactsDirectory = path.join(this.runDirectory, "artifacts");
  }

  public async init(): Promise<void> {
    await mkdir(this.runDirectory, { recursive: true });
    await mkdir(this.checkpointsDirectory, { recursive: true });
    await mkdir(this.artifactsDirectory, { recursive: true });
  }

  public resolve(fileName: string): string {
    return path.join(this.runDirectory, fileName);
  }

  public resolveArtifact(fileName: string): string {
    return path.join(this.artifactsDirectory, fileName);
  }

  public async writeJson(fileName: string, value: unknown): Promise<string> {
    const target = this.resolve(fileName);
    await writeFile(target, JSON.stringify(value, null, 2), "utf8");
    return target;
  }

  public async writeArtifactJson(fileName: string, value: unknown): Promise<string> {
    const target = this.resolveArtifact(fileName);
    await writeFile(target, JSON.stringify(value, null, 2), "utf8");
    return target;
  }

  public async writeArtifactText(fileName: string, value: string): Promise<string> {
    const target = this.resolveArtifact(fileName);
    await writeFile(target, value, "utf8");
    return target;
  }

  public async writeText(fileName: string, value: string): Promise<string> {
    const target = this.resolve(fileName);
    await writeFile(target, value, "utf8");
    return target;
  }

  public async appendJsonl(fileName: string, value: unknown): Promise<string> {
    const target = this.resolve(fileName);
    const serialized = `${JSON.stringify(value)}\n`;
    await writeFile(target, serialized, { encoding: "utf8", flag: "a" });
    return target;
  }

  public async readJson<T>(fileName: string): Promise<T> {
    try {
      const raw = await readFile(this.resolve(fileName), "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new AppError("NOT_FOUND", `Artifact not found: ${fileName}`, {
        cause: error,
      });
    }
  }

  public async readText(fileName: string): Promise<string> {
    return readFile(this.resolve(fileName), "utf8");
  }

  public async listRunFiles(): Promise<string[]> {
    return readdir(this.runDirectory);
  }
}
