import type { BridgeConfig } from "./config.js";
import type { AgentAdapter } from "./adapters/adapter.js";
import { MockAdapter } from "./adapters/mock/mock-adapter.js";
import { OpenCodeAdapter } from "./opencode/adapter.js";
import { EventStore } from "./core/event-store.js";
import { Redactor } from "./core/redact.js";
import { TaskManager } from "./core/task-manager.js";
import { BridgeError } from "./errors.js";
import type { Logger } from "./logging.js";
import { ModelPolicy } from "./policy/model-policy.js";
import { PathPolicy } from "./policy/path-policy.js";

export interface BridgeServices {
  config: BridgeConfig;
  adapter: AgentAdapter;
  manager: TaskManager;
  logger: Logger;
}

export function createAdapter(config: BridgeConfig, logger: Logger): AgentAdapter {
  if (config.adapter === "mock") {
    return new MockAdapter({
      scenario: config.mock.scenario,
      delayMs: config.mock.delay_ms,
    });
  }

  if (config.adapter === "opencode") {
    return new OpenCodeAdapter({ config, logger });
  }

  throw new BridgeError("INVALID_CONFIG", `Unknown adapter: ${String(config.adapter)}`);
}

export function createServices(
  config: BridgeConfig,
  adapter: AgentAdapter,
  logger: Logger,
): BridgeServices {
  const redactor = new Redactor({ maxStringChars: config.history.max_payload_chars });
  const eventStore = new EventStore({
    redactor,
    maxPayloadChars: config.history.max_payload_chars,
  });
  const modelPolicy = new ModelPolicy(config.models);
  const pathPolicy = new PathPolicy(
    config.security.allowed_repo_roots,
    config.security.require_git_for_writes,
  );
  const manager = new TaskManager({
    config,
    adapter,
    modelPolicy,
    pathPolicy,
    eventStore,
    logger,
  });

  return { config, adapter, manager, logger };
}
