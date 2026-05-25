import { EventEmitter } from "node:events";

import type { EventRepository } from "../repositories/base.js";
import { HeadlessEventSchema, type HeadlessEvent, type HeadlessEventType } from "../schemas.js";

export interface PublishHeadlessEventInput {
  tenantId: string;
  sessionId: string;
  runId: string;
  type: HeadlessEventType;
  data: Record<string, unknown>;
  timestamp?: string;
}

export class StreamService {
  private readonly emitter = new EventEmitter();

  public constructor(private readonly events: EventRepository) {
    this.emitter.setMaxListeners(0);
  }

  public async publish(input: PublishHeadlessEventInput): Promise<HeadlessEvent> {
    const event = HeadlessEventSchema.parse({
      eventId: await this.events.nextEventId(input.runId),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      runId: input.runId,
      type: input.type,
      timestamp: input.timestamp ?? new Date().toISOString(),
      data: input.data,
    });
    const persisted = await this.events.append(event);
    this.emitter.emit(this.topic(input.runId), persisted);
    return persisted;
  }

  public async replay(tenantId: string, runId: string, afterEventId?: string): Promise<HeadlessEvent[]> {
    return this.events.listByRun(tenantId, runId, afterEventId);
  }

  public subscribe(runId: string, listener: (event: HeadlessEvent) => void): () => void {
    const topic = this.topic(runId);
    this.emitter.on(topic, listener);
    return () => {
      this.emitter.off(topic, listener);
    };
  }

  private topic(runId: string): string {
    return `run:${runId}`;
  }
}
