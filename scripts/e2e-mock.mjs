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
  const { json } = await call("agent_wait", { task_ids: [taskId], timeout_seconds: 5 });
  assert(json.ready_task_ids?.includes(taskId), `wait did not return ${taskId}`);
  assert(json.tasks?.[0]?.status === status, `task did not become ${status}`);
  return json.tasks[0];
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
    "agent_capabilities",
    "agent_preflight",
    "agent_wait",
    "agent_events",
    "agent_viewer",
    "agent_spawn",
    "agent_status",
    "agent_history",
    "agent_message",
    "agent_diff",
    "agent_delivery",
    "agent_result",
    "agent_abort",
    "agent_list",
    "agent_cleanup",
  ]) {
    assert(toolNames.includes(name), `missing tool ${name}`);
  }

  const capabilities = await call("agent_capabilities", {});
  assert(capabilities.json.capabilities?.simulated === true, "mock capabilities not disclosed");
  const preflight = await call("agent_preflight", {
    repo_root: repo,
    read_only: true,
  });
  assert(preflight.json.preflight?.workspace?.kind === "repo_root", "preflight workspace mismatch");
  assert(preflight.json.preflight?.permissions?.edit === false, "preflight read-only permissions mismatch");
  assert(preflight.json.preflight?.workspace?.base_commit, "preflight missing git base");
  const viewer = await call("agent_viewer", {});
  assert(viewer.json.viewer?.url?.startsWith("http://127.0.0.1:"), "local viewer URL missing");
  assert(viewer.json.viewer.auto_open === false, "mock acceptance should not open a browser");

  const spawned = await call("agent_spawn", {
    task: "Acceptance task: inspect the repository.",
    repo_root: repo,
    task_type: "analysis",
    model: "mock/echo",
    timeout_seconds: 10,
    idempotency_key: "acceptance-1",
    context_files: ["README.md"],
  });
  assert(spawned.json.ok === true, `spawn failed: ${JSON.stringify(spawned.json)}`);
  const taskId = spawned.json.task.task_id;
  assert(spawned.json.task.read_only === true, "spawn should default to read-only");
  assert(spawned.json.viewer_url === viewer.json.viewer.url, "spawn should expose its automatic viewer");
  const completed = await waitForStatus(taskId, "completed");
  assert(completed.session_id, "missing session ID");

  const eventsPage = await call("agent_events", {
    task_id: taskId,
    after: 0,
    timeout_seconds: 1,
    limit: 100,
  });
  assert(eventsPage.json.events?.length > 0, "agent_events returned no events");
  assert(eventsPage.json.task_terminal === true, "agent_events did not report terminal task");

  const history = await call("agent_history", { task_id: taskId, limit: 100 });
  const eventTypes = history.json.events.map((event) => event.event_type);
  assert(eventTypes.includes("task.completed"), "missing task.completed event");

  const delivery = await call("agent_delivery", { task_id: taskId });
  assert(delivery.json.delivery?.verification?.status === "simulated", "delivery verification mismatch");
  assert(delivery.json.delivery?.verification?.tests_run_by_bridge === false, "delivery claimed bridge tests");
  assert(delivery.json.delivery?.commands?.length > 0, "delivery missing observed commands");
  assert(delivery.json.delivery?.unverified?.length > 0, "delivery missing unverified fields");
  assert(delivery.json.delivery?.context?.verified === true, "delivery context manifest missing");
  assert(delivery.json.delivery?.context?.files?.[0]?.sha256, "delivery context hash missing");

  const result = await call("agent_result", { task_id: taskId });
  assert(result.json.result?.summary, "agent_result missing summary");
  assert(
    result.json.result?.artifacts?.execution_completed === true,
    "agent_result missing execution status",
  );

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
