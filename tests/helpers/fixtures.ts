import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MockAdapter } from "../../src/adapters/mock/mock-adapter.js";
import { createServices, type BridgeServices } from "../../src/app.js";
import {
  loadConfig,
  type BridgeConfig,
  type MockScenario,
} from "../../src/config.js";
import { createLogger } from "../../src/logging.js";

const execFileAsync = promisify(execFile);

export async function makeTempDir(prefix = "cob-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function makeGitRepo(parent: string, name = "repo"): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true });
  await execFileAsync("git", ["-C", directory, "init", "-q"]);
  await writeFile(join(directory, "README.md"), "# test repository\n", "utf8");
  await execFileAsync("git", ["-C", directory, "add", "-A"]);
  await execFileAsync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Codex Bridge Test",
    "-c",
    "user.email=bridge-test@example.invalid",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  return realpath(directory);
}

export interface HarnessOptions {
  scenario?: MockScenario;
  delayMs?: number;
  maxConcurrent?: number;
  maxQueue?: number;
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
  allowedRoots?: string[];
  repoRoot?: string;
}

export interface Harness {
  tempDir: string;
  repoRoot: string;
  configPath: string;
  config: BridgeConfig;
  adapter: MockAdapter;
  services: BridgeServices;
  cleanup(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const tempDir = await makeTempDir();
  const repoRoot = options.repoRoot ?? (await makeGitRepo(tempDir));
  const allowedRoots =
    options.allowedRoots ?? [await realpath(tempDir)];
  const scenario = options.scenario ?? "success";
  const delayMs = options.delayMs ?? 5;

  const configObject = {
    adapter: "mock",
    log_level: "silent",
    scheduler: {
      max_concurrent: options.maxConcurrent ?? 2,
      max_queue: options.maxQueue ?? 10,
      default_timeout_seconds: options.defaultTimeoutSeconds ?? 30,
      max_timeout_seconds: options.maxTimeoutSeconds ?? 60,
    },
    models: {
      default: "mock/echo",
      allow: ["mock/echo"],
      expensive: [],
      allow_expensive: false,
      max_cost_usd: null,
      max_tokens: null,
    },
    security: {
      allowed_repo_roots: allowedRoots,
      require_git_for_writes: true,
      allow_external_directories: false,
    },
    history: {
      default_limit: 20,
      max_limit: 100,
      max_payload_chars: 4000,
      max_delegation_chars: 50_000,
    },
    mock: {
      scenario,
      delay_ms: delayMs,
    },
  };

  const configPath = join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify(configObject, null, 2), "utf8");
  const config = loadConfig({ path: configPath, env: {} });
  const logger = createLogger("silent");
  const adapter = new MockAdapter({ scenario, delayMs });
  const services = createServices(config, adapter, logger);

  return {
    tempDir,
    repoRoot,
    configPath,
    config,
    adapter,
    services,
    async cleanup() {
      await services.manager.shutdown();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export function spawnInput(repoRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    task: "Add a focused unit test for the parser edge case.",
    repo_root: repoRoot,
    task_type: "testing" as const,
    model: "mock/echo",
    read_only: false,
    timeout_seconds: 10,
    ...overrides,
  };
}
