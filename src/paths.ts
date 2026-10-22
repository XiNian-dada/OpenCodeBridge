import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./config.js";

export function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-opencode-bridge");
  }
  return join(homedir(), ".local", "share", "codex-opencode-bridge");
}

export function resolveDataDir(config: BridgeConfig): string {
  return config.data_dir ?? defaultDataDir();
}
