#!/usr/bin/env node
import { IpcTaskClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/ensure.js";
import { daemonPaths, readDaemonState } from "../daemon/state.js";
import { defaultConfigPath, loadConfig } from "../config.js";
import { toErrorPayload } from "../errors.js";
import { createLogger } from "../logging.js";
import type { BridgeEvent, TaskStatus, TaskView } from "../types.js";
import { TASK_STATUSES } from "../types.js";

interface Parsed {
  command: string | undefined;
  args: string[];
  json: boolean;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, args, json } = parsed;
  const configPath = process.env.BRIDGE_CONFIG ?? defaultConfigPath();
  const config = loadConfig({ path: configPath });
  const logger = createLogger("error");

  if (command === "viewer") {
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const viewer = await client.viewer();
      if (viewer.url === null) throw new Error("Viewer is disabled; enable viewer.enabled and restart the daemon");
      print({ ok: true, viewer }, json);
    } finally { client.close(); }
    return;
  }

  if (command === "approve") {
    const approvalId = args[0];
    if (approvalId === undefined) throw new Error("Usage: bridge approve <approval-id>");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const result = await client.approveCleanup(approvalId);
      print({ ok: true, ...result }, json);
    } finally {
      client.close();
    }
    return;
  }

  if (command === "resume") {
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      print({ ok: true, ...(await client.resumeProvider()) }, json);
    } finally {
      client.close();
    }
    return;
  }

  if (command === "daemon") {
    await daemonCommand(config, configPath, args, json);
    return;
  }

  if (command === "tasks") {
    const filter = parseTasksFilter(args);
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const tasks = await client.list(filter);
      if (json) {
        print({ ok: true, tasks }, true);
      } else if (tasks.length === 0) {
        process.stdout.write("No tasks.\n");
      } else {
        for (const task of tasks) printTaskLine(task);
      }
    } finally {
      client.close();
    }
    return;
  }

  if (command === "preflight") {
    const repoRoot = firstPositional(args, ["--model"]);
    if (repoRoot === undefined) {
      throw new Error("Usage: bridge preflight <repo-root> [--writable] [--model <provider/model>]");
    }
    const readOnly = !args.includes("--writable");
    const model = stringOption(args, "--model");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const preflight = await client.preflight({
        repo_root: repoRoot,
        read_only: readOnly,
        ...(model === undefined ? {} : { model }),
      });
      print({ ok: true, preflight }, json);
    } finally {
      client.close();
    }
    return;
  }

  if (command === "status") {
    const taskId = args[0];
    if (taskId === undefined) throw new Error("Usage: bridge status <task-id>");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const task = await client.status(taskId);
      if (json) print({ ok: true, task }, true);
      else printTaskDetail(task);
    } finally {
      client.close();
    }
    return;
  }

  if (command === "logs") {
    const taskId = firstPositional(args, ["--limit", "--types"]);
    if (taskId === undefined) throw new Error("Usage: bridge logs <task-id> [--follow]");
    const follow = args.includes("--follow");
    const limit = numericOption(args, "--limit") ?? 20;
    const types = listOption(args, "--types");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      await printLogs(client, taskId, { follow, limit, ...(types === undefined ? {} : { types }), json });
    } finally {
      client.close();
    }
    return;
  }

  if (command === "diff") {
    const taskId = firstPositional(args, ["--file", "--max-chars"]);
    if (taskId === undefined) throw new Error("Usage: bridge diff <task-id>");
    const file = stringOption(args, "--file");
    const maxChars = numericOption(args, "--max-chars");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const diff = await client.diff(taskId, {
        ...(file === undefined ? {} : { file }),
        ...(maxChars === undefined ? {} : { maxChars }),
      });
      if (json) print({ ok: true, ...diff }, true);
      else printDiff(diff);
    } finally {
      client.close();
    }
    return;
  }

  if (command === "delivery") {
    const taskId = args[0];
    if (taskId === undefined) throw new Error("Usage: bridge delivery <task-id> [--max-chars N]");
    const maxChars = numericOption(args, "--max-chars");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const delivery = await client.delivery({
        task_id: taskId,
        ...(maxChars === undefined ? {} : { max_chars: maxChars }),
      });
      print({ ok: true, delivery }, json);
    } finally {
      client.close();
    }
    return;
  }

  if (command === "abort") {
    const taskId = args[0];
    if (taskId === undefined) throw new Error("Usage: bridge abort <task-id>");
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const result = await client.abort(taskId);
      print({ ok: true, ...result }, json);
    } finally {
      client.close();
    }
    return;
  }

  if (command === "message") {
    const taskId = args.shift();
    const message = args.join(" ").trim();
    if (taskId === undefined || message === "") {
      throw new Error("Usage: bridge message <task-id> <message>");
    }
    const client = await ensureDaemon({ config, configPath, logger });
    try {
      const result = await client.message(taskId, message);
      print({ ok: true, ...result }, json);
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
      } else if (arg !== "--json") {
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
      print({ ok: true, ...result }, json);
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

  throw new Error(usage());
}

function parseArgs(argv: string[]): Parsed {
  const args = [...argv];
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json");
  return { command: filtered.shift(), args: filtered, json };
}

async function daemonCommand(
  config: ReturnType<typeof loadConfig>,
  configPath: string,
  args: string[],
  json: boolean,
): Promise<void> {
  const subcommand = args[0];
  const paths = daemonPaths(config);
  if (subcommand === "status") {
    const state = await readDaemonState(paths.statePath);
    if (state === null) print({ running: false, socket: paths.socketPath }, json);
    else print({ running: true, ...state }, json);
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
      print({ ok: true, stopped: true, ...(state === null ? {} : { pid: state.pid }) }, json);
    } catch {
      print({ ok: true, stopped: false, reason: "daemon_not_running" }, json);
    }
    return;
  }
  void configPath;
  throw new Error("Usage: bridge daemon <status|stop>");
}

function parseTasksFilter(args: string[]) {
  const status = stringOption(args, "--status");
  if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return {
    ...(status === undefined ? {} : { status: status as TaskStatus }),
    ...(stringOption(args, "--repo") === undefined ? {} : { repo_root: stringOption(args, "--repo") }),
    ...(stringOption(args, "--model") === undefined ? {} : { model: stringOption(args, "--model") }),
    limit: numericOption(args, "--limit") ?? 20,
  };
}

async function printLogs(
  client: IpcTaskClient,
  taskId: string,
  options: { follow: boolean; limit: number; types?: string[]; json: boolean },
): Promise<void> {
  let after = 0;
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  process.once("SIGINT", onSignal);

  try {
    if (!options.follow) {
      const page = await client.history(taskId, {
        limit: options.limit,
        ...(options.types === undefined ? {} : { types: options.types }),
      });
      for (const event of page.events) printEvent(event, options.json);
      return;
    }

    while (!stopped) {
      const page = await client.history(taskId, {
        limit: 100,
        after,
        ...(options.types === undefined ? {} : { types: options.types }),
      });
      for (const event of page.events) {
        printEvent(event, options.json);
        after = Math.max(after, event.sequence);
      }
      if (page.events.length === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    process.off("SIGINT", onSignal);
  }
}

function printTaskLine(task: TaskView): void {
  process.stdout.write(
    `${task.task_id}  ${task.status.padEnd(18)} turn=${task.turn}  ${task.model}  ${task.repo_root}\n`,
  );
}

function printTaskDetail(task: TaskView): void {
  process.stdout.write(
    [
      `task_id: ${task.task_id}`,
      `status: ${task.status}`,
      `stage: ${task.stage}`,
      `turn: ${task.turn}`,
      `parent: ${task.parent_task_id ?? "-"}`,
      `root: ${task.root_task_id}`,
      `model: ${task.model}`,
      `session: ${task.session_id ?? "-"}`,
      `repo: ${task.repo_root}`,
      `worktree: ${task.worktree_path ?? "-"}`,
      `created: ${task.created_at}`,
      `started: ${task.started_at ?? "-"}`,
      `ended: ${task.ended_at ?? "-"}`,
      `duration_ms: ${task.duration_ms}`,
      `tokens: ${task.usage.total_tokens} (in=${task.usage.input_tokens} out=${task.usage.output_tokens})`,
      `cost_usd: ${task.cost_known ? String(task.estimated_cost_usd) : "unknown"}`,
      `error: ${task.error === null ? "-" : `${task.error.code}: ${task.error.message}`}`,
      `summary: ${task.result_summary ?? "-"}`,
      `last_event: ${task.last_event === null ? "-" : `#${task.last_event.sequence} ${task.last_event.event_type}`}`,
      "",
    ].join("\n"),
  );
}

function printEvent(event: BridgeEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  const payload = JSON.stringify(event.payload);
  const compact = payload.length > 800 ? `${payload.slice(0, 800)}…` : payload;
  process.stdout.write(
    `#${String(event.sequence).padStart(4, "0")} ${event.timestamp} ${event.source.padEnd(8)} ${event.event_type} ${compact}\n`,
  );
}

function printDiff(diff: Awaited<ReturnType<IpcTaskClient["diff"]>>): void {
  process.stdout.write(
    [
      `task: ${diff.task_id}`,
      `available: ${diff.available}${diff.reason === undefined ? "" : ` (${diff.reason})`}`,
      `worktree: ${diff.worktree_path ?? "-"}`,
      `base: ${diff.base_commit ?? "-"}`,
      `files: ${diff.files.length} (+${diff.additions} -${diff.deletions})`,
      `modified: ${diff.modified.join(", ") || "-"}`,
      `added: ${diff.added.join(", ") || "-"}`,
      `deleted: ${diff.deleted.join(", ") || "-"}`,
      `untracked: ${diff.untracked.join(", ") || "-"}`,
      "",
      diff.patch,
      "",
    ].join("\n"),
  );
}

function firstPositional(args: string[], valueOptions: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (valueOptions.includes(arg)) index++;
      continue;
    }
    return arg;
  }
  return undefined;
}

function stringOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function numericOption(args: string[], name: string): number | undefined {
  const value = stringOption(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function listOption(args: string[], name: string): string[] | undefined {
  const value = stringOption(args, name);
  return value === undefined ? undefined : value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage: bridge <command>",
    "",
    "  tasks [--status <status>] [--repo <path>] [--model <model>] [--limit N]",
    "  preflight <repo-root> [--writable] [--model <provider/model>]",
    "  status <task-id>",
    "  logs <task-id> [--follow] [--limit N] [--types a,b]",
    "  viewer [--json]  Open the automatically updating local conversation viewer",
    "  diff <task-id> [--file <path>] [--max-chars N]",
    "  delivery <task-id> [--max-chars N]",
    "  abort <task-id>",
    "  message <task-id> <message>",
    "  cleanup [--apply] [--task <id>] [--no-logs] [--no-worktrees]",
    "  approve <approval-id>",
    "  resume  Clear a provider/account pause after the restriction is resolved",
    "  daemon <status|stop>",
    "",
    "Add --json for machine-readable output.",
  ].join("\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: toErrorPayload(error) })}\n`);
  process.exitCode = 1;
});
