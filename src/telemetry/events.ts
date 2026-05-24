import type { TelemetryEvent } from "../schemas.js";

export function createEvent(event: Omit<TelemetryEvent, "timestamp">): TelemetryEvent {
  return {
    timestamp: new Date().toISOString(),
    ...event,
  };
}
