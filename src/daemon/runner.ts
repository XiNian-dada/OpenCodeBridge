#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createAdapter, createServices } from "../app.js";
import { defaultConfigPath, loadConfig } from "../config.js";
import { toErrorPayload } from "../errors.js";
import { createLogger } from "../logging.js";
import { openSqliteStore } from "../storage/sqlite-store.js";
import { IpcServer } from "./server.js";
import { daemonPaths, removeDaemonState, writeDaemonState } from "./state.js";
import { TaskViewer } from "../viewer/server.js";

export const DAEMON_VERSION = "0.1.0";

async function main(): Promise<void> {
  const configPath = process.env.BRIDGE_CONFIG ?? defaultConfigPath();
  const config = loadConfig({ path: configPath });
  const logger = createLogger(config.log_level);
  const paths = daemonPaths(config);
  await mkdir(dirname(paths.logPath), { recursive: true, mode: 0o700 });

  const store = openSqliteStore(paths.databasePath);
  const adapter = createAdapter(config, logger);
  const services = createServices(config, adapter, logger, store);
  const viewer = config.viewer?.enabled === false ? null : new TaskViewer({
    service: services.service,
    logger,
    autoOpen: config.viewer?.auto_open ?? (config.adapter === "opencode"),
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "bridge daemon shutting down");
    await server.close().catch((error: unknown) => {
      logger.error({ error: toErrorPayload(error) }, "IPC server close failed");
    });
    await viewer?.close().catch(() => logger.warn("Viewer close failed"));
    await services.manager.shutdown().catch((error: unknown) => {
      logger.error({ error: toErrorPayload(error) }, "task manager shutdown failed");
    });
    await removeDaemonState(paths.statePath);
    store.close();
    process.exitCode = 0;
  };

  const server = new IpcServer({
    socketPath: paths.socketPath,
    service: services.service,
    logger,
    onShutdown: () => shutdown("ipc_shutdown"),
  });

  try {
    if (viewer !== null) {
      await viewer.listen();
      services.service.setViewer(viewer);
    }
    await server.listen();
  } catch (error) {
    logger.error({ error: toErrorPayload(error) }, "bridge daemon failed to listen");
    await viewer?.close();
    store.close();
    process.exitCode = 1;
    return;
  }

  await writeDaemonState(paths.statePath, {
    pid: process.pid,
    socket: paths.socketPath,
    started_at: new Date().toISOString(),
    version: DAEMON_VERSION,
  });

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    logger.error({ error: toErrorPayload(error) }, "uncaught exception");
    void shutdown("uncaught_exception");
  });
  process.once("unhandledRejection", (error) => {
    logger.error({ error: toErrorPayload(error) }, "unhandled rejection");
    void shutdown("unhandled_rejection");
  });

  logger.info(
    { pid: process.pid, socket: paths.socketPath, database: paths.databasePath },
    "bridge daemon ready",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: toErrorPayload(error), note: "bridge daemon failed" })}\n`,
  );
  process.exitCode = 1;
});
