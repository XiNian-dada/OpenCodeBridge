import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "../errors.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface SandboxProfileOptions {
  taskDir: string;
  tempDir: string;
  worktreePath: string;
  gitDir?: string;
}

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

export function buildSeatbeltProfile(options: SandboxProfileOptions): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const opencodeData = join(dataHome, "opencode");
  const writable = [
    options.taskDir,
    options.tempDir,
    options.worktreePath,
    ...(options.gitDir === undefined ? [] : [options.gitDir]),
    join(opencodeData, "log"),
    join(opencodeData, "shell"),
    join(opencodeData, "snapshot"),
    join(stateHome, "opencode"),
    join(cacheHome, "opencode"),
  ];

  const rules = writable
    .map((path) => `  (subpath "${escapeSchemeString(path)}")`)
    .join("\n");

  return `(version 1)
(deny default)
(allow process*)
(allow file-read*)
(allow file-write*
${rules}
  (literal "/dev/null"))
(allow sysctl-read)
(allow mach-lookup)
(allow network*)
(allow signal)
(allow ipc-posix*)
`;
}

export async function writeSeatbeltProfile(options: SandboxProfileOptions): Promise<string> {
  if (!sandboxAvailable()) {
    throw new BridgeError("SANDBOX_UNAVAILABLE", "macOS sandbox-exec is not available");
  }
  await mkdir(options.taskDir, { recursive: true, mode: 0o700 });
  await mkdir(options.tempDir, { recursive: true, mode: 0o700 });
  const profilePath = join(options.taskDir, "sandbox.sb");
  await writeFile(profilePath, buildSeatbeltProfile(options), { mode: 0o600 });
  return profilePath;
}

function escapeSchemeString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
