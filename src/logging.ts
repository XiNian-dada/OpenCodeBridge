import pino, { type Logger } from "pino";

export type { Logger };

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export function createLogger(level: LogLevel): Logger {
  return pino(
    {
      level,
      base: { service: "codex-opencode-bridge" },
      redact: {
        paths: [
          "*.password",
          "*.apiKey",
          "*.api_key",
          "*.authorization",
          "*.token",
          "*.secret",
          "env",
          "*.env",
        ],
        censor: "[REDACTED]",
      },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}
