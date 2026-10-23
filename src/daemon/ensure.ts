import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "../config.js";
import { BridgeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { IpcTaskClient } from "./client.js";
import { daemonPaths } from "./state.js";

export interface EnsureDaemonOptions {
  config: BridgeConfig;
  configPath: string;
  logger: Logger;
  startupTimeoutMs?: number;
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<IpcTaskClient> {
  const paths = daemonPaths(options.config);
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;

  const existing = await tryConnect(paths.socketPath);
  if (existing !== null) return existing;

  mkdirSync(dirname(paths.logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.logPath, "a", 0o600);
  const entry = daemonEntryPath();
  const args = entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        BRIDGE_CONFIG: options.configPath,
      },
      cwd: process.cwd(),
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const client = await tryConnect(paths.socketPath, 300);
    if (client !== null) return client;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new BridgeError(
    "DAEMON_UNAVAILABLE",
    "Bridge daemon did not become ready. Check the daemon log.",
    { details: { log_path: paths.logPath, socket: paths.socketPath } },
  );
}

async function tryConnect(socketPath: string, timeoutMs = 500): Promise<IpcTaskClient | null> {
  try {
    return await IpcTaskClient.connect(socketPath, timeoutMs);
  } catch {
    return null;
  }
}

function daemonEntryPath(): string {
  const override = process.env.BRIDGE_DAEMON_ENTRY;
  if (override !== undefined && override !== "") return override;
  const current = fileURLToPath(import.meta.url);
  const here = dirname(current);
  const isTypeScript = current.endsWith(".ts");
  return join(here, isTypeScript ? "runner.ts" : "runner.js");
}
