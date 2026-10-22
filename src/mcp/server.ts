#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createAdapter, createServices, type BridgeServices } from "../app.js";
import { loadConfig, type BridgeConfig } from "../config.js";
import { toErrorPayload } from "../errors.js";
import { createLogger, type Logger } from "../logging.js";
import { registerAgentTools } from "./tools.js";

export const SERVER_NAME = "codex-opencode-bridge";
export const SERVER_VERSION = "0.1.0";

function instructions(config: BridgeConfig): string {
  return [
    "Codex is the primary agent; this bridge delegates only bounded tasks to OpenCode.",
    "Use agent_spawn for clear, limited work and poll agent_status until a terminal state.",
    "Use agent_history to inspect what was delegated and what the agent actually did; do not assume success from a summary.",
    "Use agent_diff to review worktree changes before accepting or merging them; writable OpenCode tasks run in isolated Git worktrees.",
    "Use agent_abort when work must stop; the bridge verifies the adapter stopped before reporting cancellation.",
    "The bridge never auto-upgrades to a more expensive model. Ask the user to update the local configuration if a model is not allowlisted.",
    config.adapter === "mock"
      ? "Current adapter: mock. Results and diffs are simulated for Phase 1 and must not be treated as real code changes."
      : "Current adapter: OpenCode.",
  ].join("\n");
}

export function createMcpServer(services: BridgeServices): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(services.config) },
  );
  registerAgentTools(server, services);
  return server;
}

function shutdown(
  logger: Logger,
  services: BridgeServices,
  handle: { close(): Promise<void> },
  signal: string,
): void {
  logger.info({ signal }, "shutting down");
  void services.manager
    .shutdown()
    .catch((error: unknown) => {
      logger.error({ error: toErrorPayload(error) }, "task manager shutdown failed");
    })
    .finally(() => handle.close())
    .catch((error: unknown) => {
      logger.error({ error: toErrorPayload(error) }, "MCP close failed");
      process.exitCode = 1;
    });
}

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.log_level);
  const adapter = createAdapter(config, logger);
  const services = createServices(config, adapter, logger);

  const handle = serveStdio(() => createMcpServer(services), {
    onerror: (error) => logger.error({ error: toErrorPayload(error) }, "MCP transport error"),
  });

  process.once("SIGINT", () => shutdown(logger, services, handle, "SIGINT"));
  process.once("SIGTERM", () => shutdown(logger, services, handle, "SIGTERM"));

  logger.info(
    { adapter: adapter.name, version: SERVER_VERSION, log_level: config.log_level },
    "MCP server listening on stdio",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: toErrorPayload(error),
      note: "codex-opencode-bridge MCP server failed to start",
    })}\n`,
  );
  process.exitCode = 1;
}
