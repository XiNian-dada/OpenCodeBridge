"use strict";
const key = new URLSearchParams(location.hash.slice(1)).get("key");
const $ = (id) => document.getElementById(id);
const state = { selected: null, tasks: [], events: [], after: 0, serverFocus: null, taskListKey: "" };
const labels = { queued: "排队中", preparing: "准备中", running: "执行中", waiting_permission: "等待授权", completed: "已完成", failed: "失败", timed_out: "已超时", cancelling: "正在停止", cancelled: "已取消", interrupted: "已中断", blocked: "受阻" };

async function api(path) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取失败");
  return data;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function selectTask(id, manual = false) {
  if (manual) $("follow").checked = false;
  if (id === state.selected) return;
  state.selected = id;
  state.events = [];
  state.after = 0;
  $("timeline").replaceChildren(node("p", "正在读取执行记录…", "empty"));
  renderTasks();
  renderOverview();
}

function renderTasks() {
  const signature = state.selected + state.tasks.map((task) => task.task_id + task.status).join("|");
  if (signature === state.taskListKey) return;
  state.taskListKey = signature;
  $("task-count").textContent = String(state.tasks.length);
  const items = state.tasks.map((task) => {
    const button = node("button", undefined, "task");
    button.type = "button";
    button.setAttribute("aria-current", String(task.task_id === state.selected));
    const title = node("span", undefined, "task-title");
    const repo = task.repo_root.split("/").filter(Boolean).at(-1) || task.repo_root;
    title.append(node("span", `${repo} · 第 ${task.turn} 轮`), node("span", "", `dot ${task.status}`));
    button.append(title, node("div", `${labels[task.status] || task.status} · ${task.task_id.slice(5, 13)}`, "task-meta"));
    button.addEventListener("click", () => { selectTask(task.task_id, true); });
    return button;
  });
  $("tasks").replaceChildren(...(items.length ? items : [node("p", "还没有任务", "empty")]));
}

function renderOverview() {
  const task = state.tasks.find((item) => item.task_id === state.selected);
  $("overview").hidden = !task;
  if (!task) return;
  $("task-id").textContent = task.task_id;
  $("status").textContent = labels[task.status] || task.status;
  $("status").className = `status ${["failed", "timed_out", "interrupted", "blocked"].includes(task.status) ? "failure" : ""}`;
  $("model").textContent = task.model;
  $("duration").textContent = `${(task.duration_ms / 1000).toFixed(1)} 秒`;
  $("turn").textContent = `第 ${task.turn} 轮 · ${task.read_only ? "只读" : "隔离编辑"}`;
  $("repo").textContent = task.repo_root;
}

function renderEvents() {
  const expanded = new Set([...$("timeline").querySelectorAll("details[open]")].map((detail) => detail.closest("article").dataset.sequence));
  const showSystem = $("show-system").checked;
  const lastReply = state.events.findLast((e) => e.event_type === "opencode.message" && e.payload.role === "assistant");
  const cards = [];
  for (const event of state.events) {
    const p = event.payload;
    let title, body, kind = "system", collapsible = false;
    switch (event.event_type) {
      case "task.created": title = "Codex → Bridge · 委派任务"; body = p.task; kind = "request"; break;
      case "task.resumed": title = "Codex → OpenCode · 追加任务"; body = p.message ?? p.task; kind = "request"; break;
      case "prompt.sent": title = "Bridge → OpenCode · 实际 Prompt"; body = p.prompt; kind = "request"; collapsible = true; break;
      case "opencode.message":
        if (p.role === "assistant" && event === lastReply) { title = "OpenCode · 回复"; body = p.text; kind = "reply"; }
        else if (!showSystem) continue;
        else { title = `会话回读 · ${p.role}`; body = p.text; collapsible = true; }
        break;
      case "tool.called": title = `工具调用${p.tool ? " · " + p.tool : ""}`; body = JSON.stringify(p.input ?? p, null, 2); kind = "tool"; break;
      case "tool.completed": title = "工具执行结果"; body = JSON.stringify(p, null, 2); kind = "tool"; collapsible = true; break;
      case "tool.failed": case "opencode.error": title = "执行错误"; body = JSON.stringify(p, null, 2); kind = "failure"; break;
      case "shell.started": case "shell.ended": title = "命令执行记录"; body = JSON.stringify(p, null, 2); kind = "tool"; break;
      default:
        if (!showSystem) continue;
        title = event.event_type; body = JSON.stringify(p, null, 2); collapsible = true;
    }
    if (p._truncated) body = `此事件已被日志策略截断：\n${p.preview}`;
    if (body === undefined) body = JSON.stringify(p, null, 2);
    const card = node("article", undefined, `entry ${kind}`);
    card.dataset.sequence = String(event.sequence);
    const head = node("div", undefined, "entry-head");
    const time = node("time", new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour12: false }));
    time.dateTime = event.timestamp;
    head.append(node("strong", title), time);
    const content = node("div", undefined, "entry-body");
    if (collapsible) {
      const details = node("details");
      details.open = expanded.has(String(event.sequence));
      details.append(node("summary", `${event.event_type === "prompt.sent" ? "展开实际发送内容" : "展开原始记录"} · #${event.sequence}`), node("pre", body));
      content.append(details);
    } else content.append(node(kind === "reply" || kind === "request" ? "p" : "pre", body));
    card.append(head, content);
    cards.push(card);
  }
  $("timeline").replaceChildren(...(cards.length ? cards : [node("p", "等待任务事件…", "empty")]));
}

async function tick() {
  try {
    if (!key) throw new Error("链接缺少访问密钥，请运行 bridge viewer 重新打开。");
    const data = await api("/api/tasks");
    state.tasks = data.tasks;
    const wanted = data.focused_task_id || data.tasks[0]?.task_id;
    if (!state.selected || ($("follow").checked && wanted !== state.serverFocus)) selectTask(wanted);
    state.serverFocus = wanted;
    renderTasks();
    renderOverview();
    if (state.selected) {
      const id = state.selected;
      let changed = false, more = true, pages = 0;
      while (more && pages++ < 10 && state.selected === id) {
        const page = await api(`/api/tasks/${encodeURIComponent(id)}/events?after=${state.after}`);
        if (state.selected !== id) break;
        state.events.push(...page.events);
        if (page.events.length) {
          state.after = page.events.at(-1).sequence;
          changed = true;
        }
        more = page.has_more && page.events.length > 0;
      }
      if (changed) renderEvents();
    }
    $("connection").textContent = "● 已连接本机 Bridge · 每秒自动更新";
    $("connection").className = "connection";
    $("updated").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (error) {
    $("connection").textContent = `${error.message} · 将自动重连；Daemon 重启后可用 bridge viewer 获取新链接。`;
    $("connection").className = "connection error";
  } finally { setTimeout(tick, document.hidden ? 5000 : 1000); }
}
$("show-system").addEventListener("change", renderEvents);
$("follow").addEventListener("change", () => { if ($("follow").checked) state.serverFocus = null; });
void tick();
