import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "../errors.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type SandboxMode = "read" | "write";

export interface SandboxProfileOptions {
  /** Read mode denies access to the user home and external mounts by default. */
  mode?: SandboxMode;
  taskDir: string;
  tempDir: string;
  /** The directory the worker is allowed to read (and, in write mode, edit). */
  worktreePath: string;
  gitDir?: string;
  /** When set, outbound networking is restricted to this localhost gateway port. */
  gatewayPort?: number;
  /** The task has its own HOME/XDG directories under taskDir. */
  isolateConfig?: boolean;
}

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

function opencodePaths(): {
  data: string;
  state: string;
  cache: string;
  config: string;
} {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return {
    data: join(dataHome, "opencode"),
    state: join(stateHome, "opencode"),
    cache: join(cacheHome, "opencode"),
    config: join(configHome, "opencode"),
  };
}

function readRules(paths: string[]): string {
  return paths
    .map((path) => `  (subpath "${escapeSchemeString(canonicalPath(path))}")`)
    .join("\n");
}

function networkRules(options: SandboxProfileOptions): string {
  if (options.gatewayPort === undefined) return "(allow network*)";
  return `(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:${options.gatewayPort}"))`;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Writable profile: broad reads, writes confined to the worktree and task data.
 * Kept for edit-only OpenCode tasks, whose Git worktree must remain usable.
 */
export function buildSeatbeltProfile(options: SandboxProfileOptions): string {
  const opencode = opencodePaths();
  const writable = [
    options.taskDir,
    options.tempDir,
    options.worktreePath,
    ...(options.gitDir === undefined ? [] : [options.gitDir]),
    ...(options.isolateConfig === true
      ? []
      : [
          join(opencode.data, "log"),
          join(opencode.data, "shell"),
          join(opencode.data, "snapshot"),
          opencode.state,
          opencode.cache,
        ]),
  ];
  const restrictedReads = options.isolateConfig === true;
  const readable = [
    options.taskDir,
    options.tempDir,
    options.worktreePath,
    ...(options.gitDir === undefined ? [] : [options.gitDir]),
  ];
  const readPolicy = restrictedReads
    ? `(deny file-read-data (subpath "${escapeSchemeString(homedir())}"))
(deny file-read-data (subpath "/Users"))
(deny file-read-data (subpath "/Volumes"))
(deny file-read-data (subpath "/Network"))
(deny file-read-data (subpath "/private/tmp"))
(deny file-read-data (subpath "/tmp"))
(deny file-read-data (subpath "/private/var/folders"))
(deny file-read-data (subpath "/Library/Keychains"))
(allow file-read-data
${readRules(readable)})`
    : "";

  return `(version 1)
(deny default)
(allow process*)
(allow file-read*)
${readPolicy}
(allow file-write*
${readRules(writable)}
  (literal "/dev/null"))
${networkRules(options)}
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow ipc-posix*)
`;
}

/**
 * Read-only profile: allows the runtime to start, but hides the user home,
 * external mounts, and system temp outside the task area. Deny rules are used
 * because macOS 26 rejects narrow file-read allow lists. Network remains
 * available for the model provider; worker web/shell tools are denied by the
 * OpenCode permission layer.
 */
export function buildReadSeatbeltProfile(options: SandboxProfileOptions): string {
  const opencode = opencodePaths();
  const readable = [
    options.taskDir,
    options.tempDir,
    options.worktreePath,
    ...(options.isolateConfig === true
      ? []
      : [opencode.data, opencode.state, opencode.cache, opencode.config]),
  ];
  const writable = [
    options.taskDir,
    options.tempDir,
    ...(options.isolateConfig === true
      ? []
      : [opencode.data, opencode.state, opencode.cache]),
  ];

  return `(version 1)
(deny default)
(allow process*)
(allow file-read*)
(deny file-read-data (subpath "${escapeSchemeString(homedir())}"))
(deny file-read-data (subpath "/Users"))
(deny file-read-data (subpath "/Volumes"))
(deny file-read-data (subpath "/Network"))
(deny file-read-data (subpath "/private/tmp"))
(deny file-read-data (subpath "/tmp"))
(deny file-read-data (subpath "/private/var/folders"))
(deny file-read-data (subpath "/Library/Keychains"))
(allow file-read-data
${readRules(readable)})
(allow file-write*
${readRules(writable)})
${networkRules(options)}
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow ipc-posix*)
`;
}

export function buildSandboxProfile(options: SandboxProfileOptions): string {
  return (options.mode ?? "write") === "read"
    ? buildReadSeatbeltProfile(options)
    : buildSeatbeltProfile(options);
}

export async function writeSeatbeltProfile(options: SandboxProfileOptions): Promise<string> {
  if (!sandboxAvailable()) {
    throw new BridgeError("SANDBOX_UNAVAILABLE", "macOS sandbox-exec is not available");
  }
  await mkdir(options.taskDir, { recursive: true, mode: 0o700 });
  await mkdir(options.tempDir, { recursive: true, mode: 0o700 });
  const profilePath = join(options.taskDir, "sandbox.sb");
  await writeFile(profilePath, buildSandboxProfile(options), { mode: 0o600 });
  return profilePath;
}

function escapeSchemeString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
