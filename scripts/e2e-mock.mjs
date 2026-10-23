import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-acceptance-")));
const repo = join(dir, "repo");
const configPath = join(dir, "config.json");
let client = null;

function assert(condition, message) {
  if (!condition) throw new Error(`Acceptance failed: ${message}`);
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const structured = result.structuredContent;
  assert(structured !== undefined, `${name} returned no structured content`);
  return { json: structured, isError: result.isError === true };
}

async function waitForStatus(taskId, status) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { json } = await call("agent_status", { task_id: taskId });
    if (json.task?.status === status) return json.task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${taskId} to become ${status}`);
}

try {
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["-C", repo, "init", "-q"]);
  await writeFile(join(repo, "README.md"), "# acceptance\n", "utf8");
  await execFileAsync("git", ["-C", repo, "add", "-A"]);
  await execFileAsync("git", [
    "-C",
    repo,
    "-c",
    "user.name=acceptance",
    "-c",
    "user.email=acceptance@example.invalid",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  await writeFile(
    configPath,
    JSON.stringify(
      {
        adapter: "mock",
        log_level: "silent",
        data_dir: join(dir, "data"),
        scheduler: { max_concurrent: 2, max_queue: 5 },
        models: { default: "mock/echo", allow: ["mock/echo"] },
        security: { allowed_repo_roots: [dir], require_git_for_writes: true },
        mock: { scenario: "success", delay_ms: 5 },
      },
      null,
      2,
    ),
    "utf8",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/server.js"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BRIDGE_CONFIG: configPath,
    },
    stderr: "inherit",
  });
  client = new Client({ name: "acceptance", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const name of [
    "agent_spawn",
    "agent_status",
    "agent_history",
    "agent_message",
    "agent_diff",
    "agent_abort",
    "agent_list",
    "agent_cleanup",
  ]) {
    assert(toolNames.includes(name), `missing tool ${name}`);
  }

  const spawned = await call("agent_spawn", {
    task: "Acceptance task: inspect the repository.",
    repo_root: repo,
    task_type: "analysis",
    model: "mock/echo",
    read_only: true,
    timeout_seconds: 10,
    idempotency_key: "acceptance-1",
  });
  assert(spawned.json.ok === true, "spawn failed");
  const taskId = spawned.json.task.task_id;
  const completed = await waitForStatus(taskId, "completed");
  assert(completed.session_id, "missing session ID");

  const history = await call("agent_history", { task_id: taskId, limit: 100 });
  const eventTypes = history.json.events.map((event) => event.event_type);
  assert(eventTypes.includes("task.completed"), "missing task.completed event");

  const follow = await call("agent_message", {
    task_id: taskId,
    message: "Follow-up acceptance turn.",
  });
  const child = follow.json.task;
  assert(child.parent_task_id === taskId, "follow-up parent mismatch");
  assert(child.session_id === completed.session_id, "follow-up session mismatch");
  await waitForStatus(child.task_id, "completed");

  const diff = await call("agent_diff", { task_id: taskId });
  assert(diff.json.available === false, "read-only task unexpectedly has a worktree");

  const cleanup = await call("agent_cleanup", {
    dry_run: true,
    include_worktrees: true,
    include_logs: false,
  });
  assert(cleanup.json.dry_run === true, "cleanup was not a dry run");

  const listed = await call("agent_list", { limit: 10 });
  assert(listed.json.tasks.length >= 2, "task list missing turns");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      tools: toolNames,
      task_id: taskId,
      turns: listed.json.tasks.length,
      history_events: history.json.events.length,
    })}\n`,
  );
} finally {
  if (client !== null) await client.close().catch(() => undefined);
  await execFileAsync(
    process.execPath,
    ["dist/cli/index.js", "daemon", "stop"],
    { cwd: process.cwd(), env: { ...process.env, BRIDGE_CONFIG: configPath } },
  ).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
