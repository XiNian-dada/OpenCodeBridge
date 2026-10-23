#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createAdapter, createServices } from "../app.js";
import type { ToolServices } from "../core/task-service.js";
import { ensureDaemon } from "../daemon/ensure.js";
import { defaultConfigPath, loadConfig, type BridgeConfig } from "../config.js";
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
    "Use agent_message to continue a completed task in the same OpenCode session and workspace; it returns a new turn task ID linked to the original.",
    "Use agent_diff to review worktree changes before accepting or merging them; writable OpenCode tasks run in isolated Git worktrees.",
    "Use agent_abort when work must stop; the bridge verifies the adapter stopped before reporting cancellation.",
    "The bridge never auto-upgrades to a more expensive model. Ask the user to update the local configuration if a model is not allowlisted.",
    config.adapter === "mock"
      ? "Current adapter: mock. Results and diffs are simulated for Phase 1 and must not be treated as real code changes."
      : "Current adapter: OpenCode.",
  ].join("\n");
}

export function createMcpServer(services: ToolServices): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(services.config) },
  );
  registerAgentTools(server, services);
  return server;
}

async function main(): Promise<void> {
  const configPath = process.env.BRIDGE_CONFIG ?? defaultConfigPath();
  const config = loadConfig({ path: configPath });
  const logger = createLogger(config.log_level);
  const inProcess = process.env.BRIDGE_INPROCESS === "1";

  let service: ToolServices["service"];
  let mode: "inprocess" | "daemon";
  let cleanup: () => Promise<void>;

  if (inProcess) {
    const adapter = createAdapter(config, logger);
    const services = createServices(config, adapter, logger);
    service = services.service;
    mode = "inprocess";
    cleanup = async () => {
      await services.manager.shutdown();
    };
  } else {
    const client = await ensureDaemon({ config, configPath, logger });
    service = client;
    mode = "daemon";
    cleanup = async () => {
      client.close();
    };
  }

  const handle = serveStdio(() => createMcpServer({ config, service }), {
    onerror: (error) => logger.error({ error: toErrorPayload(error) }, "MCP transport error"),
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal, mode }, "MCP server shutting down");
    void cleanup()
      .catch((error: unknown) => {
        logger.error({ error: toErrorPayload(error) }, "bridge cleanup failed");
      })
      .finally(() => handle.close())
      .catch((error: unknown) => {
        logger.error({ error: toErrorPayload(error) }, "MCP close failed");
        process.exitCode = 1;
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info(
    { mode, version: SERVER_VERSION, log_level: config.log_level },
    "MCP server listening on stdio",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: toErrorPayload(error),
      note: "codex-opencode-bridge MCP server failed to start",
    })}\n`,
  );
  process.exitCode = 1;
});
