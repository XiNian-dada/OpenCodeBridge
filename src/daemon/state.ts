import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import { resolveDataDir } from "../paths.js";

export interface DaemonPaths {
  dataDir: string;
  socketPath: string;
  statePath: string;
  logPath: string;
  databasePath: string;
}

export interface DaemonState {
  pid: number;
  socket: string;
  started_at: string;
  version: string;
}

export function daemonPaths(config: BridgeConfig): DaemonPaths {
  const dataDir = resolveDataDir(config);
  return {
    dataDir,
    socketPath: join(dataDir, "bridge.sock"),
    statePath: join(dataDir, "daemon.json"),
    logPath: join(dataDir, "logs", "daemon.log"),
    databasePath: join(dataDir, "bridge.sqlite"),
  };
}

export async function writeDaemonState(path: string, state: DaemonState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readDaemonState(path: string): Promise<DaemonState | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

export async function removeDaemonState(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}
