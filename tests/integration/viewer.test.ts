import { describe, expect, it } from "vitest";
import { request } from "node:http";
import { TaskViewer } from "../../src/viewer/server.js";
import { createLogger } from "../../src/logging.js";
import { createHarness, spawnInput } from "../helpers/fixtures.js";
import type { HistoryPage } from "../../src/types.js";

interface ViewerTaskList { focused_task_id: string; tasks: Array<{ task_id: string }> }
interface ViewerHistory extends HistoryPage { task: Record<string, unknown> }
async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  return await (await fetch(url, { headers })).json() as T;
}

function connection(viewer: TaskViewer) {
  const url = new URL(viewer.info().url!);
  return { origin: url.origin, headers: { authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("key")}` } };
}

describe("local live task viewer", () => {
  it("serves local assets but requires authentication for history and rejects cross-origin or mutation requests", async () => {
    const h = await createHarness();
    const viewer = new TaskViewer({ service: h.services.service, logger: createLogger("silent") });
    try {
      await viewer.listen();
      const { origin, headers } = connection(viewer);
      const shell = await fetch(origin);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-security-policy")).toContain("connect-src 'self'");
      const shellHtml = await shell.text();
      expect(shellHtml).toContain("Codex");
      expect(shellHtml).toContain("OpenCode");
      expect(shellHtml).toContain("全部审计事件");
      expect((await fetch(`${origin}/app.js`)).headers.get("content-type")).toContain("javascript");
      expect((await fetch(`${origin}/api/tasks`)).status).toBe(401);
      expect((await fetch(`${origin}/api/tasks`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(`${origin}/api/tasks`, { headers: { ...headers, origin: "https://attacker.invalid" } })).status).toBe(403);
      // fetch rewrites Host on this runtime; use a raw HTTP request for rebinding.
      const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${origin}/api/tasks`, { headers: { ...headers, host: "attacker.invalid" } }, (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
        });
        req.once("error", reject);
        req.end();
      });
      expect(badHostStatus).toBe(403);
      expect((await fetch(`${origin}/api/tasks`, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status).toBe(403);
      expect((await fetch(`${origin}/api/tasks`, { method: "POST", headers })).status).toBe(405);
      expect((await fetch(`${origin}/api/tasks/missing/events`, { headers })).status).toBe(404);
      expect((await fetch(`${origin}/api/tasks/missing/events?after=-1`, { headers })).status).toBe(400);
      expect((await fetch(`${origin}/../../config.json`, { headers })).status).toBe(404);
    } finally { await viewer.close(); await h.cleanup(); }
  });

  it("returns a viewer URL and follows new turns without launching a system browser", async () => {
    const h = await createHarness({ delayMs: 100 });
    const viewer = new TaskViewer({ service: h.services.service, logger: createLogger("silent") });
    try {
      await viewer.listen();
      h.services.service.setViewer(viewer);
      const { origin, headers } = connection(viewer);
      const first = await h.services.service.spawn(spawnInput(h.repoRoot));
      expect(first.viewer_url).toBe(viewer.info().url);
      expect(viewer.info().auto_open).toBe(false);
      const list = await getJson<ViewerTaskList>(`${origin}/api/tasks`, headers);
      expect(list.focused_task_id).toBe(first.task.task_id);
      const initial = await getJson<ViewerHistory>(`${origin}/api/tasks/${first.task.task_id}/events`, headers);
      expect(initial.task).not.toHaveProperty("task");
      expect(initial.events.some((event: { event_type: string }) => event.event_type === "task.created")).toBe(true);
      await h.services.manager.waitForTerminal(first.task.task_id, 5000);
      const next = await getJson<ViewerHistory>(`${origin}/api/tasks/${first.task.task_id}/events?after=${initial.events.at(-1)!.sequence}`, headers);
      expect(next.events.every((event) => event.sequence > initial.events.at(-1)!.sequence)).toBe(true);
      expect(next.events.some((event: { event_type: string }) => event.event_type === "task.completed")).toBe(true);
      const second = await h.services.service.message(first.task.task_id, "Continue with the same scope");
      expect(second.task.session_id).toBe(h.services.manager.status(first.task.task_id).session_id);
      expect((await getJson<ViewerTaskList>(`${origin}/api/tasks`, headers)).focused_task_id).toBe(second.task.task_id);
      viewer.showTask(second.task.task_id);
      expect(viewer.info().auto_open).toBe(false);
      await expect(h.services.service.spawn({ ...spawnInput(h.repoRoot), model: "forbidden/model" })).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    } finally { await viewer.close(); await h.cleanup(); }
  });

  it("returns every event across pages, including original prompts and redacted tool payloads", async () => {
    const h = await createHarness();
    const viewer = new TaskViewer({ service: h.services.service, logger: createLogger("silent") });
    try {
      const original = h.adapter.start.bind(h.adapter);
      h.adapter.start = (task, prompt, context) => {
        for (let i = 0; i < 120; i++) context.emit({ source: "tool", event_type: "tool.called", payload: { index: i, api_key: "test-secret-value" } });
        return original(task, prompt, context);
      };
      await viewer.listen();
      const { origin, headers } = connection(viewer);
      const { task } = await h.services.service.spawn(spawnInput(h.repoRoot));
      await h.services.manager.waitForTerminal(task.task_id, 5000);
      let after = 0, more = true;
      const sequences: number[] = [];
      const events: Array<{ event_type: string }> = [];
      while (more) {
        const page = await getJson<ViewerHistory>(`${origin}/api/tasks/${task.task_id}/events?after=${after}`, headers);
        expect(JSON.stringify(page)).not.toContain("test-secret-value");
        sequences.push(...page.events.map((event: { sequence: number }) => event.sequence));
        events.push(...page.events);
        after = page.events.at(-1)?.sequence ?? after;
        more = page.has_more;
      }
      expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
      expect(events.filter((event) => event.event_type === "tool.called")).toHaveLength(121);
      expect(events.some((event) => event.event_type === "prompt.sent")).toBe(true);
      expect(events.some((event) => event.event_type === "opencode.message")).toBe(true);
    } finally { await viewer.close(); await h.cleanup(); }
  });

});
