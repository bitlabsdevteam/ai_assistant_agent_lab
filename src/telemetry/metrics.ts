import type { MetricRecord } from "../schemas.js";

export class MetricsCollector {
  private readonly records: MetricRecord[] = [];

  public addMetric(name: string, value: number, runId?: string): void {
    this.records.push({
      name,
      value,
      timestamp: new Date().toISOString(),
      ...(runId ? { runId } : {}),
    });
  }

  public snapshot(): MetricRecord[] {
    return [...this.records];
  }
}
