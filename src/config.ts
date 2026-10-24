import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import { BridgeError } from "./errors.js";
import type { LogLevel } from "./logging.js";

export type MockScenario = "success" | "fail" | "slow";

const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const RawConfigSchema = z
  .object({
    adapter: z.enum(["mock", "opencode"]).optional(),
    log_level: LogLevelSchema.optional(),
    data_dir: z.string().optional(),
    viewer: z.object({
      enabled: z.boolean().optional(),
      auto_open: z.boolean().optional(),
    }).strict().optional(),
    scheduler: z
      .object({
        max_concurrent: z.number().int().min(1).max(10).optional(),
        max_queue: z.number().int().min(1).max(100).optional(),
        default_timeout_seconds: z.number().int().min(1).max(3600).optional(),
        max_timeout_seconds: z.number().int().min(1).max(7200).optional(),
      })
      .strict()
      .optional(),
    models: z
      .object({
        default: z.string().min(1).nullable().optional(),
        allow: z.array(z.string().min(1)).optional(),
        expensive: z.array(z.string().min(1)).optional(),
        allow_expensive: z.boolean().optional(),
        max_cost_usd: z.number().nonnegative().nullable().optional(),
        max_tokens: z.number().int().positive().nullable().optional(),
      })
      .strict()
      .optional(),
    cleanup: z
      .object({
        log_retention_days: z.number().int().min(1).max(3650).optional(),
        worktree_retention_days: z.number().int().min(0).max(3650).optional(),
      })
      .strict()
      .optional(),
    security: z
      .object({
        allowed_repo_roots: z.array(z.string().min(1)).optional(),
        require_git_for_writes: z.boolean().optional(),
        allow_external_directories: z.boolean().optional(),
        read_sandbox: z.enum(["auto", "require", "off"]).optional(),
        model_gateway: z.enum(["auto", "require", "off"]).optional(),
      })
      .strict()
      .optional(),
    opencode: z
      .object({
        binary: z.string().min(1).optional(),
        go_api_key: z.string().max(4096).optional(),
        compatibility: z.string().min(1).optional(),
        startup_timeout_ms: z.number().int().min(1000).max(120_000).optional(),
      })
      .strict()
      .optional(),
    history: z
      .object({
        default_limit: z.number().int().min(1).max(100).optional(),
        max_limit: z.number().int().min(1).max(500).optional(),
        max_payload_chars: z.number().int().min(100).max(100_000).optional(),
        max_delegation_chars: z.number().int().min(1000).max(500_000).optional(),
      })
      .strict()
      .optional(),
    mock: z
      .object({
        scenario: z.enum(["success", "fail", "slow"]).optional(),
        delay_ms: z.number().int().min(0).max(60_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface BridgeConfig {
  adapter: "mock" | "opencode";
  log_level: LogLevel;
  data_dir: string | null;
  viewer?: { enabled: boolean; auto_open: boolean };
  scheduler: {
    max_concurrent: number;
    max_queue: number;
    default_timeout_seconds: number;
    max_timeout_seconds: number;
  };
  models: {
    default: string | null;
    allow: string[];
    expensive: string[];
    allow_expensive: boolean;
    max_cost_usd: number | null;
    max_tokens: number | null;
  };
  cleanup?: {
    log_retention_days: number;
    worktree_retention_days: number;
  };
  security: {
    allowed_repo_roots: string[];
    require_git_for_writes: boolean;
    allow_external_directories: boolean;
    read_sandbox: "auto" | "require" | "off";
    model_gateway: "auto" | "require" | "off";
  };
  opencode: {
    binary: string;
    go_api_key?: string;
    compatibility: string;
    startup_timeout_ms: number;
  };
  history: {
    default_limit: number;
    max_limit: number;
    max_payload_chars: number;
    max_delegation_chars: number;
  };
  mock: {
    scenario: MockScenario;
    delay_ms: number;
  };
}

export interface LoadConfigOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_CONFIG ?? join(homedir(), ".config", "codex-opencode-bridge", "config.json");
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function parseInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new BridgeError("INVALID_CONFIG", `${name} must be an integer`);
  }
  return parsed;
}

function applyEnvOverrides(raw: z.infer<typeof RawConfigSchema>, env: NodeJS.ProcessEnv): z.infer<typeof RawConfigSchema> {
  const next = structuredClone(raw);

  if (env.BRIDGE_ADAPTER !== undefined && env.BRIDGE_ADAPTER !== "") {
    next.adapter = env.BRIDGE_ADAPTER as "mock" | "opencode";
  }
  if (env.BRIDGE_LOG_LEVEL !== undefined && env.BRIDGE_LOG_LEVEL !== "") {
    next.log_level = env.BRIDGE_LOG_LEVEL as LogLevel;
  }
  if (env.BRIDGE_MODEL !== undefined && env.BRIDGE_MODEL !== "") {
    next.models = { ...next.models, default: env.BRIDGE_MODEL };
  }
  if (env.BRIDGE_ALLOWED_ROOTS !== undefined) {
    next.security = {
      ...next.security,
      allowed_repo_roots:
        env.BRIDGE_ALLOWED_ROOTS === ""
          ? []
          : env.BRIDGE_ALLOWED_ROOTS.split(":").filter((root) => root.length > 0),
    };
  }

  const maxConcurrent = parseInteger(env.BRIDGE_MAX_CONCURRENT, "BRIDGE_MAX_CONCURRENT");
  const maxQueue = parseInteger(env.BRIDGE_MAX_QUEUE, "BRIDGE_MAX_QUEUE");
  const defaultTimeout = parseInteger(env.BRIDGE_DEFAULT_TIMEOUT_SECONDS, "BRIDGE_DEFAULT_TIMEOUT_SECONDS");
  if (maxConcurrent !== undefined || maxQueue !== undefined || defaultTimeout !== undefined) {
    next.scheduler = {
      ...next.scheduler,
      ...(maxConcurrent === undefined ? {} : { max_concurrent: maxConcurrent }),
      ...(maxQueue === undefined ? {} : { max_queue: maxQueue }),
      ...(defaultTimeout === undefined ? {} : { default_timeout_seconds: defaultTimeout }),
    };
  }

  const mockDelay = parseInteger(env.BRIDGE_MOCK_DELAY_MS, "BRIDGE_MOCK_DELAY_MS");
  const mockScenario = env.BRIDGE_MOCK_SCENARIO;
  if (mockDelay !== undefined || mockScenario !== undefined) {
    next.mock = {
      ...next.mock,
      ...(mockDelay === undefined ? {} : { delay_ms: mockDelay }),
      ...(mockScenario === undefined || mockScenario === ""
        ? {}
        : { scenario: mockScenario as MockScenario }),
    };
  }

  return next;
}

export function loadConfig(options: LoadConfigOptions = {}): BridgeConfig {
  const env = options.env ?? process.env;
  const configPath = options.path ?? defaultConfigPath(env);

  let rawInput: unknown = {};
  if (existsSync(configPath)) {
    try {
      rawInput = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new BridgeError("INVALID_CONFIG", `Failed to read config at ${configPath}`, {
        cause: error,
        details: { path: configPath },
      });
    }
  }

  const parsed = RawConfigSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new BridgeError("INVALID_CONFIG", `Invalid config at ${configPath}`, {
      details: { issues: parsed.error.issues },
    });
  }

  const withEnv = applyEnvOverrides(parsed.data, env);
  const finalParsed = RawConfigSchema.safeParse(withEnv);
  if (!finalParsed.success) {
    throw new BridgeError("INVALID_CONFIG", "Invalid configuration from environment overrides", {
      details: { issues: finalParsed.error.issues },
    });
  }
  const raw = finalParsed.data;

  const allowedRepoRoots = (raw.security?.allowed_repo_roots ?? []).map((root) => {
    const expanded = expandHome(root);
    if (!isAbsolute(expanded)) {
      throw new BridgeError("INVALID_CONFIG", `allowed_repo_roots entry must be absolute: ${root}`);
    }
    return resolve(expanded);
  });

  const dataDir = raw.data_dir === undefined ? null : resolve(expandHome(raw.data_dir));

  return {
    adapter: raw.adapter ?? "mock",
    log_level: raw.log_level ?? "info",
    data_dir: dataDir,
    viewer: {
      enabled: raw.viewer?.enabled ?? true,
      // Legacy auto_open is accepted but never launches the system browser.
      auto_open: false,
    },
    scheduler: {
      max_concurrent: raw.scheduler?.max_concurrent ?? 2,
      max_queue: raw.scheduler?.max_queue ?? 10,
      default_timeout_seconds: raw.scheduler?.default_timeout_seconds ?? 300,
      max_timeout_seconds: raw.scheduler?.max_timeout_seconds ?? 1800,
    },
    models: {
      default: raw.models?.default ?? (raw.adapter === "opencode" ? "opencode-go/deepseek-v4.1-flash" : null),
      allow: raw.models?.allow ?? (raw.adapter === "opencode" ? ["opencode-go/*"] : []),
      expensive: raw.models?.expensive ?? [],
      allow_expensive: raw.models?.allow_expensive ?? false,
      max_cost_usd: raw.models?.max_cost_usd ?? null,
      max_tokens: raw.models?.max_tokens ?? null,
    },
    cleanup: {
      log_retention_days: raw.cleanup?.log_retention_days ?? 30,
      worktree_retention_days: raw.cleanup?.worktree_retention_days ?? 30,
    },
    security: {
      allowed_repo_roots: allowedRepoRoots,
      require_git_for_writes: raw.security?.require_git_for_writes ?? true,
      allow_external_directories: raw.security?.allow_external_directories ?? false,
      read_sandbox: raw.security?.read_sandbox ?? "auto",
      model_gateway: raw.security?.model_gateway ?? "require",
    },
    opencode: {
      binary: raw.opencode?.binary ?? "opencode",
      ...(raw.opencode?.go_api_key ? { go_api_key: raw.opencode.go_api_key } : {}),
      compatibility: raw.opencode?.compatibility ?? "2.1.x",
      startup_timeout_ms: raw.opencode?.startup_timeout_ms ?? 15_000,
    },
    history: {
      default_limit: raw.history?.default_limit ?? 20,
      max_limit: raw.history?.max_limit ?? 100,
      max_payload_chars: raw.history?.max_payload_chars ?? 2000,
      max_delegation_chars: raw.history?.max_delegation_chars ?? 50_000,
    },
    mock: {
      scenario: raw.mock?.scenario ?? "success",
      delay_ms: raw.mock?.delay_ms ?? 20,
    },
  };
}
