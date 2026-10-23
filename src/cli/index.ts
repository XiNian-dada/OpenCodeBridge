#!/usr/bin/env node
import { IpcTaskClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/ensure.js";
import { daemonPaths, readDaemonState } from "../daemon/state.js";
import { defaultConfigPath, loadConfig } from "../config.js";
import { toErrorPayload } from "../errors.js";
import { createLogger } from "../logging.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  const configPath = process.env.BRIDGE_CONFIG ?? defaultConfigPath();
  const config = loadConfig({ path: configPath });
  const logger = createLogger("error");

  if (command === "approve") {
    const approvalId = args[0];
    if (approvalId === undefined) throw new Error("Usage: bridge approve <approval-id>");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const result = await client.approveCleanup(approvalId);
      print({ ok: true, ...result });
    } finally {
      client.close();
    }
    return;
  }

  if (command === "cleanup") {
    const taskIds: string[] = [];
    let dryRun = true;
    let includeLogs = true;
    let includeWorktrees = true;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--apply") dryRun = false;
      else if (arg === "--no-logs") includeLogs = false;
      else if (arg === "--no-worktrees") includeWorktrees = false;
      else if (arg === "--task") {
        const next = args[++index];
        if (next === undefined) throw new Error("--task requires a task ID");
        taskIds.push(next);
      } else {
        throw new Error(`Unknown cleanup option: ${arg}`);
      }
    }
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const result = await client.cleanup({
        ...(taskIds.length === 0 ? {} : { task_ids: taskIds }),
        dry_run: dryRun,
        include_worktrees: includeWorktrees,
        include_logs: includeLogs,
      });
      print({ ok: true, ...result });
      for (const action of result.actions) {
        if (action.approval_id !== undefined) {
          process.stderr.write(`Approval required: bridge approve ${action.approval_id}\n`);
        }
      }
    } finally {
      client.close();
    }
    return;
  }

  if (command === "daemon") {
    const subcommand = args[0];
    const paths = daemonPaths(config);
    if (subcommand === "status") {
      const state = await readDaemonState(paths.statePath);
      if (state === null) {
        print({ running: false, socket: paths.socketPath });
      } else {
        print({ running: true, ...state });
      }
      return;
    }
    if (subcommand === "stop") {
      const state = await readDaemonState(paths.statePath);
      try {
        const client = await IpcTaskClient.connect(paths.socketPath, 500);
        try {
          await client.shutdownDaemon();
        } finally {
          client.close();
        }
        print({ ok: true, stopped: true, ...(state === null ? {} : { pid: state.pid }) });
      } catch {
        print({ ok: true, stopped: false, reason: "daemon_not_running" });
      }
      return;
    }
    throw new Error("Usage: bridge daemon <status|stop>");
  }

  throw new Error(
    "Usage: bridge <approve <id> | cleanup [--apply] [--task <id>] [--no-logs] [--no-worktrees] | daemon <status|stop>>",
  );
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: toErrorPayload(error) })}\n`);
  process.exitCode = 1;
});
