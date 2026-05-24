import pino, { type Logger } from "pino";

import type { Settings } from "./schemas.js";

export function createLogger(settings: Settings): Logger {
  const options = {
    level: settings.logLevel,
    redact: {
      paths: ["*.apiKey", "*.token", "*.secret", "details.headers.authorization"],
      censor: "[REDACTED]",
    },
    ...(settings.env === "development"
      ? {
          transport: {
            target: "pino/file",
            options: { destination: 1 },
          },
        }
      : {}),
  };
  return pino(options);
}
