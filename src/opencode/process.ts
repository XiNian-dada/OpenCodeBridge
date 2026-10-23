import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BridgeError, isBridgeError } from "../errors.js";
import {
  SANDBOX_EXEC,
  sandboxAvailable,
  writeSeatbeltProfile,
  type SandboxMode,
} from "../security/sandbox.js";
import type { Logger } from "../logging.js";
import { OpenCodeHttpClient, OpenCodeHttpError } from "./http-client.js";
import type { OpenCodeInfo } from "./types.js";

export interface ManagedOpenCodeServerOptions {
  binary: string;
  cwd: string;
  dataDir: string;
  taskId: string;
  configContent: Record<string, unknown>;
  compatibility: string;
  startupTimeoutMs: number;
  logger: Logger;
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
  sandbox?: { mode?: SandboxMode; worktreePath: string; gitDir?: string };
}

export interface ManagedOpenCodeServer {
  client: OpenCodeHttpClient;
  info: OpenCodeInfo;
  pid: number;
  port: number;
  logPath: string;
  sandboxed: boolean;
  stop(): Promise<void>;
}

export function versionMatches(version: string, pattern: string): boolean {
  const actual = version.split(".").map((part) => Number.parseInt(part, 10));
  const expected = pattern.split(".");

  for (let index = 0; index < expected.length; index++) {
    const part = expected[index];
    if (part === undefined || part === "x" || part === "*") return true;
    if (actual[index] !== Number.parseInt(part, 10)) return false;
  }
  return true;
}

export async function startManagedOpenCodeServer(
  options: ManagedOpenCodeServerOptions,
): Promise<ManagedOpenCodeServer> {
  const port = await findFreePort();
  const password = randomBytes(32).toString("base64url");
  const baseUrl = `http://127.0.0.1:${port}`;
  const taskDir = join(options.dataDir, "tasks", options.taskId);
  const logDir = join(options.dataDir, "logs");
  const tempDir = join(taskDir, "tmp");
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  await mkdir(logDir, { recursive: true, mode: 0o700 });

  let profilePath: string | null = null;
  if (options.sandbox !== undefined) {
    if (!sandboxAvailable()) {
      throw new BridgeError("SANDBOX_UNAVAILABLE", "OpenCode sandboxing requires macOS sandbox-exec");
    }
    profilePath = await writeSeatbeltProfile({
      mode: options.sandbox.mode ?? "write",
      taskDir,
      tempDir,
      worktreePath: options.sandbox.worktreePath,
      ...(options.sandbox.gitDir === undefined ? {} : { gitDir: options.sandbox.gitDir }),
    });
  }

  const logPath = join(logDir, `opencode-${options.taskId}.log`);
  const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  let stderrTail = "";

  const env: NodeJS.ProcessEnv = {
    ...sanitizeEnvironment(process.env),
    ...options.extraEnv,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DB: join(taskDir, "opencode.db"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.configContent),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    ...(profilePath === null ? {} : { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir }),
  };
  if (env.HOME === undefined || env.HOME === "") env.HOME = homedir();

  let child: ChildProcess;
  try {
    const command = profilePath === null ? options.binary : SANDBOX_EXEC;
    const args = profilePath === null
      ? ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
      : ["-f", profilePath, options.binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)];
    child = spawn(
      command,
      args,
      {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );
  } catch (error) {
    logStream.end();
    throw new BridgeError("OPENCODE_SPAWN_FAILED", "Failed to spawn OpenCode server", {
      cause: error,
      details: { binary: options.binary },
    });
  }

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000);
  });
  child.stderr?.pipe(logStream, { end: false });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let exited = false;
  void exitPromise.then(() => {
    exited = true;
  });

  const client = new OpenCodeHttpClient({
    baseUrl,
    password,
    requestTimeoutMs: Math.min(5000, options.startupTimeoutMs),
  });

  const stopped = { value: false };
  const onAbort = () => {
    void stop();
  };
  let stop: () => Promise<void>;
  stop = async () => {
    if (stopped.value) return;
    stopped.value = true;
    options.signal?.removeEventListener("abort", onAbort);
    await terminateProcess(child, exitPromise);
    logStream.end();
  };

  try {
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        await stop();
        throw new BridgeError("TASK_ABORTED", "OpenCode server startup was aborted");
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const info = await waitForInfo(client, options.startupTimeoutMs, () => exited, () => stderrTail);
    if (!versionMatches(info.version, options.compatibility)) {
      throw new BridgeError(
        "OPENCODE_INCOMPATIBLE",
        `OpenCode ${info.version} does not match required compatibility ${options.compatibility}`,
        { details: { version: info.version, compatibility: options.compatibility } },
      );
    }

    options.logger.debug(
      { task_id: options.taskId, pid: info.pid, port, log_path: logPath, version: info.version },
      "OpenCode server started",
    );

    return {
      client,
      info,
      pid: child.pid ?? info.pid,
      port,
      logPath,
      sandboxed: profilePath !== null,
      stop,
    };
  } catch (error) {
    await stop();
    if (isBridgeError(error)) throw error;

    const tail = await readLogTail(logPath);
    throw new BridgeError("OPENCODE_SPAWN_FAILED", "OpenCode server failed to start", {
      cause: error,
      retryable: true,
      details: {
        binary: options.binary,
        log_path: logPath,
        stderr: tail || stderrTail,
      },
    });
  }
}

async function waitForInfo(
  client: OpenCodeHttpClient,
  timeoutMs: number,
  hasExited: () => boolean,
  stderr: () => string,
): Promise<OpenCodeInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new BridgeError("OPENCODE_SPAWN_FAILED", "OpenCode server exited during startup", {
        details: { stderr: stderr() },
      });
    }
    try {
      return await client.info();
    } catch (error) {
      lastError = error;
      if (error instanceof OpenCodeHttpError && error.status === 401) {
        throw new BridgeError("OPENCODE_SPAWN_FAILED", "OpenCode server rejected the bridge password", {
          cause: error,
          details: { status: error.status },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new BridgeError("OPENCODE_SPAWN_FAILED", "Timed out waiting for OpenCode server", {
    cause: lastError,
    details: { timeout_ms: timeoutMs, stderr: stderr() },
  });
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new BridgeError("OPENCODE_SPAWN_FAILED", "Could not allocate a local port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function terminateProcess(
  child: ChildProcess,
  exitPromise: Promise<unknown>,
): Promise<void> {
  if (child.pid === undefined) return;
  signalProcess(child, "SIGTERM");
  const exited = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (exited) return;
  signalProcess(child, "SIGKILL");
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

async function readLogTail(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return text.slice(-4000);
  } catch {
    return "";
  }
}

const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
]);

const SAFE_ENV_PREFIXES = ["LC_", "XDG_"];

// Model transport needs provider credentials. Everything else from the parent
// environment (cloud CLIs, Git hosts, SSH agents, CI tokens) is removed.
const PROVIDER_ENV_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "OPENROUTER_",
  "DEEPSEEK_",
  "GEMINI_",
  "GOOGLE_",
  "GOOGLE_GENERATIVE_AI_",
  "MISTRAL_",
  "GROQ_",
  "XAI_",
  "COHERE_",
  "TOGETHER_",
  "FIREWORKS_",
  "PERPLEXITY_",
  "AZURE_OPENAI_",
  "OLLAMA_",
];

export function sanitizeEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (
      SAFE_ENV_KEYS.has(key) ||
      SAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      output[key] = value;
    }
  }
  return output;
}
