"use strict";

const key = new URLSearchParams(location.hash.slice(1)).get("key");
const $ = (id) => document.getElementById(id);

const TERMINAL_STATUSES = new Set([
  "completed", "failed", "timed_out", "cancelled", "interrupted", "blocked",
]);
const TERMINAL_EVENTS = new Set([
  "task.completed", "task.failed", "task.timed_out", "task.cancelled",
  "task.interrupted", "task.blocked",
]);
const TOOL_EVENTS = new Set([
  "tool.called", "tool.progress", "tool.completed", "tool.failed",
  "shell.started", "shell.ended",
]);
const FAILURE_STATUSES = new Set([
  "failed", "timed_out", "interrupted", "blocked", "cancelling",
]);
const STATUS_LABELS = {
  queued: "排队中",
  preparing: "准备中",
  running: "执行中",
  waiting_permission: "等待授权",
  completed: "已完成",
  failed: "失败",
  timed_out: "已超时",
  cancelling: "正在停止",
  cancelled: "已取消",
  interrupted: "已中断",
  blocked: "受阻",
};

const state = {
  selectedRoot: null,
  tasks: [],
  conversations: [],
  lineageCache: [],
  eventsByTask: new Map(),
  afterByTask: new Map(),
  loadedTerminal: new Set(),
  serverFocusRoot: null,
  serverFocusTask: null,
  sidebarKey: "",
  historyExpanded: false,
  outputOffsets: new Map(),
  headerKey: "",
  transcriptKey: "",
  firstRender: true,
  generation: 0,
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function taskRoot(task) {
  return task.root_task_id || task.task_id;
}

function isTerminal(task) {
  return TERMINAL_STATUSES.has(task.status);
}

function basename(path) {
  const parts = String(path ?? "").split("/").filter(Boolean);
  return parts.at(-1) ?? String(path ?? "");
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function stringify(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeJsonStringFragment(text, start) {
  let output = "";
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') break;
    if (char !== "\\") {
      output += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) break;
    if (next === "n") output += "\n";
    else if (next === "t") output += "\t";
    else if (next === "r") output += "\r";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        output += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      output += "u";
    } else {
      output += next;
    }
    index += 2;
  }
  return output;
}

function extractJsonStringField(text, field) {
  if (typeof text !== "string") return "";
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(text);
  if (match === null) return "";
  return decodeJsonStringFragment(text, match.index + match[0].length);
}

function payloadText(payload, field) {
  if (payload === null || payload === undefined) return "";
  if (typeof payload[field] === "string") return payload[field];
  if (payload._truncated === true && typeof payload.preview === "string") {
    const parsed = tryParseJson(payload.preview);
    if (parsed !== null && typeof parsed[field] === "string") return parsed[field];
    return extractJsonStringField(payload.preview, field);
  }
  return "";
}

function appendInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) {
      parent.append(document.createTextNode(text.slice(last, match.index)));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      parent.append(node("strong", token.slice(2, -2)));
    } else {
      parent.append(node("code", token.slice(1, -1)));
    }
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function renderMarkdown(text) {
  const container = node("div", undefined, "bubble-text markdown");
  const lines = String(text).split("\n");
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const element = node("p");
    paragraph.forEach((line, index) => {
      if (index > 0) element.append(node("br"));
      appendInline(element, line);
    });
    container.append(element);
    paragraph = [];
  };
  const flushList = () => {
    if (list !== null) {
      container.append(list.element);
      list = null;
    }
  };
  const flushCode = () => {
    if (code === null) return;
    const pre = node("pre");
    pre.append(node("code", code.join("\n")));
    container.append(pre);
    code = null;
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (code === null) {
        flushParagraph();
        flushList();
        code = [];
      } else {
        flushCode();
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = Math.min(5, (heading[1]?.length ?? 1) + 2);
      container.append(node(`h${level}`, heading[2], "md-heading"));
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flushParagraph();
      if (list === null || list.type !== "ul") {
        flushList();
        list = { type: "ul", element: node("ul") };
      }
      const item = node("li");
      appendInline(item, bullet[1] ?? "");
      list.element.append(item);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered !== null) {
      flushParagraph();
      if (list === null || list.type !== "ol") {
        flushList();
        list = { type: "ol", element: node("ol") };
      }
      const item = node("li");
      appendInline(item, ordered[1] ?? "");
      list.element.append(item);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushCode();
  return container;
}

function eventText(event) {
  return payloadText(event.payload, "text");
}

function delegationText(event) {
  const payload = event.payload ?? {};
  if (typeof payload.task === "string") return payload.task;
  if (typeof payload.message === "string") return payload.message;
  const extracted = payloadText(payload, "task") || payloadText(payload, "message");
  if (extracted !== "") return extracted;
  if (typeof payload.preview === "string") return payload.preview;
  return "（内容已按日志策略截断）";
}

function promptOf(event) {
  if (event === undefined || event === null) return "";
  const extracted = payloadText(event.payload, "prompt");
  if (extracted !== "") return extracted;
  return typeof event.payload?.preview === "string" ? event.payload.preview : "";
}

function displayValue(value) {
  if (value !== null && typeof value === "object" && value._truncated === true) {
    const preview = typeof value.preview === "string" ? value.preview : "";
    return `${preview}\n\n[记录已按日志策略截断，原始长度 ${value.original_chars ?? "未知"}]`;
  }
  return stringify(value);
}

function callIdOf(event) {
  const payload = event.payload ?? {};
  const direct = payload.call_id ?? payload.callId ?? payload.id;
  if (typeof direct === "string" || typeof direct === "number") return direct;
  if (payload._truncated === true && typeof payload.preview === "string") {
    const match = /"(?:call_id|callId|id)"\s*:\s*"([^"]+)"/.exec(payload.preview);
    if (match !== null) return match[1];
  }
  return null;
}

function inferToolName(event) {
  const payload = event.payload ?? {};
  if (typeof payload.tool === "string") return payload.tool;
  if (typeof payload.name === "string") return payload.name;
  const input = payload.input ?? {};
  if (typeof input.command === "string") return "shell";
  if (typeof input.pattern === "string") return "glob";
  if (typeof input.query === "string") return "grep";
  if (typeof input.filePath === "string" || typeof input.file_path === "string") return "edit";
  if (typeof input.path === "string") return "read";
  if (typeof input.url === "string") return "webfetch";
  return "tool";
}

function toolOutput(payload) {
  if (payload === null || payload === undefined) return null;
  if (payload._truncated === true) {
    const text = extractJsonStringField(payload.preview, "text");
    if (text !== "") {
      return `${text}\n\n[记录已按日志策略截断，原始长度 ${payload.original_chars ?? "未知"}]`;
    }
    return displayValue(payload);
  }
  if (Array.isArray(payload.content)) {
    const parts = payload.content
      .map((item) => typeof item?.text === "string" ? item.text : stringify(item))
      .filter((item) => item !== "");
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof payload.output === "string") return payload.output;
  return payload;
}

function errorText(event) {
  const payload = event.payload ?? {};
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  return stringify(payload);
}

function groupConversations(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const root = taskRoot(task);
    let group = groups.get(root);
    if (group === undefined) {
      group = { root, tasks: [], latest: task };
      groups.set(root, group);
    }
    group.tasks.push(task);
    if (String(task.created_at ?? "").localeCompare(String(group.latest.created_at ?? "")) > 0) {
      group.latest = task;
    }
  }
  for (const group of groups.values()) {
    group.tasks.sort(
      (a, b) =>
        (a.turn ?? 0) - (b.turn ?? 0) ||
        String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    );
    group.latest = group.tasks.at(-1);
  }
  return [...groups.values()].sort((a, b) =>
    String(b.latest.created_at ?? "").localeCompare(String(a.latest.created_at ?? "")),
  );
}

function currentLineage() {
  const root = state.selectedRoot;
  if (root === null) return [];
  const tasks = state.tasks.filter((task) => taskRoot(task) === root);
  if (tasks.length > 0) {
    tasks.sort(
      (a, b) =>
        (a.turn ?? 0) - (b.turn ?? 0) ||
        String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    );
    state.lineageCache = tasks;
    return tasks;
  }
  return state.lineageCache.filter((task) => taskRoot(task) === root);
}

function selectedConversation() {
  const tasks = currentLineage();
  if (tasks.length === 0) return null;
  return { root: state.selectedRoot, tasks, latest: tasks.at(-1) };
}

function selectRoot(root, manual = false) {
  if (manual) $("follow").checked = false;
  if (root === state.selectedRoot) return;

  state.selectedRoot = root;
  state.generation += 1;
  state.eventsByTask.clear();
  state.afterByTask.clear();
  state.loadedTerminal.clear();
  state.lineageCache = [];
  state.sidebarKey = "";
  state.headerKey = "";
  state.transcriptKey = "";
  state.firstRender = true;

  $("chat").replaceChildren(node("p", "正在读取会话…", "empty"));
  $("jump").hidden = true;
  renderSidebar();
  renderHeader();
}

async function api(path) {
  const response = await fetch(path, {
    headers: { authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function fetchTaskEvents(taskId, generation) {
  let after = state.afterByTask.get(taskId) ?? 0;
  let pages = 0;

  while (pages++ < 50) {
    if (generation !== state.generation) return;
    const page = await api(
      `/api/tasks/${encodeURIComponent(taskId)}/events?after=${after}`,
    );
    if (generation !== state.generation) return;
    const events = Array.isArray(page.events) ? page.events : [];
    if (events.length > 0) {
      const list = state.eventsByTask.get(taskId) ?? [];
      list.push(...events);
      state.eventsByTask.set(taskId, list);
      after = events.at(-1).sequence;
      state.afterByTask.set(taskId, after);
    }
    if (!page.has_more || events.length === 0) break;
  }
}

function chip(label, value, kind = "") {
  const element = node("span", undefined, `chip${kind ? ` ${kind}` : ""}`);
  element.append(
    node("span", label, "chip-label"),
    node("span", value, "chip-value"),
  );
  if (kind === "path") element.title = value;
  return element;
}

function statusChip(status) {
  const element = node("span", undefined, `chip status-chip ${status}`);
  element.append(
    node("span", "", `dot ${status}`),
    node("span", STATUS_LABELS[status] ?? status, "chip-value"),
  );
  return element;
}

function renderSidebar() {
  const conversations = state.conversations;
  const signature = `${conversations
    .map((group) => `${group.root}:${group.latest.task_id}:${group.tasks.map((task) => `${task.task_id}:${task.status}`).join(",")}`)
    .join("|")}|${state.selectedRoot}`;
  if (signature === state.sidebarKey) return;
  state.sidebarKey = signature;

  $("task-count").textContent = String(conversations.length);
  const renderConversation = (group) => {
    const latest = group.latest;
    const active = group.tasks.some((task) => !isTerminal(task));
    const button = node("button", undefined, `conversation ${active ? "active" : "inactive"}`);
    button.type = "button";
    button.title = latest.repo_root ?? "";
    button.setAttribute("aria-current", String(group.root === state.selectedRoot));

    const title = node("span", undefined, "conversation-title");
    title.append(
      node("span", basename(latest.repo_root) || "会话"),
      node("span", "", `dot ${latest.status}`),
    );

    const meta = node("div", undefined, "conversation-meta");
    meta.append(
      node("span", `${STATUS_LABELS[latest.status] ?? latest.status} · 第 ${latest.turn ?? 1} 轮`),
      node("span", formatStamp(latest.created_at)),
    );

    button.append(title, meta);
    button.addEventListener("click", () => selectRoot(group.root, true));
    return button;
  };
  const active = conversations.filter((group) => group.tasks.some((task) => !isTerminal(task)));
  const history = conversations.filter((group) => group.tasks.every(isTerminal));
  const items = [...active, ...history.slice(0, 5)].map(renderConversation);
  if (history.length > 5) {
    const older = node("details", undefined, "older-conversations");
    older.open = state.historyExpanded;
    older.append(node("summary", `更早的历史会话 · ${history.length - 5}`));
    older.append(...history.slice(5).map(renderConversation));
    older.addEventListener("toggle", () => { state.historyExpanded = older.open; });
    items.push(older);
  }

  $("tasks").replaceChildren(
    ...(items.length > 0 ? items : [node("p", "还没有委派会话", "sidebar-empty")]),
  );
}

function renderHeader() {
  const conversation = selectedConversation();
  const latest = conversation?.latest ?? null;
  const title = latest ? basename(latest.repo_root) || "委派会话" : "委派会话";
  const signature = latest
    ? `${latest.task_id}:${latest.status}:${latest.duration_ms}:${latest.turn}:${latest.model}:${latest.repo_root}:${latest.queue_position}`
    : "none";

  if (signature !== state.headerKey) {
    state.headerKey = signature;
    $("conversation-title").textContent = title;
    document.title = latest ? `${title} · Bridge` : "Bridge · 委派会话";

    const pieces = [];
    if (latest) {
      pieces.push(statusChip(latest.status));
      pieces.push(chip("模型", latest.model ?? "—", "model"));
      pieces.push(chip("轮次", `第 ${latest.turn ?? 1} 轮`));
      if (typeof latest.duration_ms === "number" && latest.duration_ms > 0) {
        pieces.push(chip("耗时", formatDuration(latest.duration_ms)));
      }
      if (latest.queue_position !== null && latest.queue_position !== undefined) {
        pieces.push(chip("队列", `第 ${latest.queue_position} 位`));
      }
      pieces.push(chip("仓库", latest.repo_root ?? "—", "path"));
    } else {
      pieces.push(chip("状态", "等待任务"));
    }
    $("conversation-meta").replaceChildren(...pieces);
  }
}

function mergeEvents(lineage) {
  const turnByTask = new Map(lineage.map((task) => [task.task_id, task.turn ?? 1]));
  const merged = [];
  for (const task of lineage) {
    for (const event of state.eventsByTask.get(task.task_id) ?? []) {
      merged.push({ event, turn: turnByTask.get(event.task_id) ?? task.turn ?? 1 });
    }
  }
  merged.sort((a, b) => (a.turn - b.turn) || (a.event.sequence - b.event.sequence));
  return merged;
}

function resolveToolKey(event, groups) {
  const callId = callIdOf(event);
  if (callId !== null) {
    return `${event.task_id}:${callId}`;
  }
  if (event.event_type === "tool.called" || event.event_type === "shell.started") {
    return `${event.task_id}:seq:${event.sequence}`;
  }
  const tool = inferToolName(event);
  for (const [groupKey, group] of groups) {
    if (group.taskId === event.task_id && group.tool === tool && group.status === "running") {
      return groupKey;
    }
  }
  return `${event.task_id}:seq:${event.sequence}`;
}

function statusEntry(event, task, turn) {
  const status = event
    ? event.event_type.slice("task.".length)
    : task?.status ?? "unknown";
  const duration = event?.payload?.duration_ms ?? task?.duration_ms;
  const error = event?.payload?.error?.message ?? task?.error?.message;
  const detail = [];
  if (typeof duration === "number" && duration > 0) detail.push(formatDuration(duration));
  if (typeof error === "string" && error !== "" && status !== "completed") detail.push(error);

  return {
    kind: "status",
    status,
    turn,
    event,
    task,
    detail: detail.join(" · "),
    order: event?.sequence ?? Number.MAX_SAFE_INTEGER,
  };
}

function buildEntries(lineage, merged) {
  const showAudit = $("show-system").checked;
  const taskById = new Map(lineage.map((task) => [task.task_id, task]));
  const promptByTask = new Map();
  const finalAssistant = new Map();
  const toolGroups = new Map();
  const eventGroupKeys = new Map();
  const terminalSeen = new Set();

  for (const { event } of merged) {
    if (event.event_type === "prompt.sent") {
      promptByTask.set(event.task_id, event);
    }
    if (
      event.event_type === "opencode.message" &&
      payloadText(event.payload, "role") === "assistant" &&
      eventText(event) !== ""
    ) {
      finalAssistant.set(event.task_id, event.sequence);
    }
    if (TOOL_EVENTS.has(event.event_type)) {
      const groupKey = resolveToolKey(event, toolGroups);
      let group = toolGroups.get(groupKey);
      if (group === undefined) {
        group = {
          key: groupKey,
          taskId: event.task_id,
          firstSequence: event.sequence,
          tool: inferToolName(event),
          kind: "tool",
          input: null,
          output: null,
          progress: null,
          status: "running",
          events: [],
        };
        toolGroups.set(groupKey, group);
      }
      group.events.push(event);
      eventGroupKeys.set(`${event.task_id}:${event.sequence}`, groupKey);

      if (event.event_type === "tool.called") {
        group.tool = inferToolName(event);
        group.input = event.payload?.input ?? event.payload ?? null;
      } else if (event.event_type === "shell.started") {
        group.kind = "shell";
        group.tool = "shell";
        group.input = event.payload?.input ?? event.payload ?? null;
      } else if (event.event_type === "tool.progress") {
        group.progress = event.payload?.output ?? event.payload ?? null;
      } else if (event.event_type === "tool.completed" || event.event_type === "shell.ended") {
        group.status = "completed";
        group.output = toolOutput(event.payload);
      } else if (event.event_type === "tool.failed") {
        group.status = "failed";
        group.output = event.payload?.error ?? toolOutput(event.payload);
      }
    }
    if (TERMINAL_EVENTS.has(event.event_type)) terminalSeen.add(event.task_id);
  }

  const entries = [];
  const consumedTools = new Set();

  for (const { event, turn } of merged) {
    if (event.event_type === "task.created" || event.event_type === "task.resumed") {
      const prompt = promptByTask.get(event.task_id);
      entries.push({
        kind: "codex",
        label: event.event_type === "task.created"
          ? `委派任务 · 第 ${turn} 轮`
          : `追加指令 · 第 ${turn} 轮`,
        turn,
        event,
        text: delegationText(event),
        promptText: promptOf(prompt),
        truncated: event.payload?._truncated === true,
        order: event.sequence,
      });
      continue;
    }

    if (event.event_type === "prompt.sent") continue;

    if (event.event_type === "opencode.message") {
      const role = payloadText(event.payload, "role");
      const text = eventText(event);
      if (
        role === "assistant" &&
        finalAssistant.get(event.task_id) === event.sequence &&
        text !== ""
      ) {
        entries.push({
          kind: "opencode",
          label: `回复 · 第 ${turn} 轮`,
          turn,
          event,
          text,
          truncated: event.payload?._truncated === true,
          order: event.sequence,
        });
      } else if (showAudit) {
        entries.push({
          kind: "audit",
          turn,
          event,
          text: `${role ?? "message"} 回读：${text}`,
          order: event.sequence,
        });
      }
      continue;
    }

    if (TOOL_EVENTS.has(event.event_type)) {
      const groupKey = eventGroupKeys.get(`${event.task_id}:${event.sequence}`);
      if (groupKey !== undefined && !consumedTools.has(groupKey)) {
        const group = toolGroups.get(groupKey);
        if (group !== undefined) {
          consumedTools.add(groupKey);
          entries.push({ kind: "tool", turn, group, event, order: group.firstSequence });
        }
      }
      continue;
    }

    if (TERMINAL_EVENTS.has(event.event_type)) {
      entries.push(statusEntry(event, taskById.get(event.task_id), turn));
      continue;
    }

    if (event.event_type === "opencode.error") {
      entries.push({
        kind: "error",
        turn,
        event,
        text: errorText(event),
        order: event.sequence,
      });
      continue;
    }

    if (showAudit) {
      entries.push({ kind: "audit", turn, event, order: event.sequence });
    }
  }

  for (const task of lineage) {
    if (isTerminal(task) && !terminalSeen.has(task.task_id)) {
      entries.push(statusEntry(null, task, task.turn ?? 1));
    }
  }

  const active = lineage.find((task) => !isTerminal(task));
  if (active !== undefined) {
    entries.push({
      kind: "typing",
      task: active,
      turn: active.turn ?? 1,
      order: Number.MAX_SAFE_INTEGER,
    });
  }

  entries.sort((a, b) => (a.turn - b.turn) || (a.order - b.order));
  return entries;
}

function entryKey(entry) {
  switch (entry.kind) {
    case "codex":
    case "opencode":
    case "audit":
    case "error":
      return `${entry.kind}:${entry.event.task_id}:${entry.event.sequence}`;
    case "tool":
      return `tool:${entry.group.key}`;
    case "status":
      return `status:${entry.task?.task_id ?? entry.event?.task_id}:${entry.status}:${entry.event?.sequence ?? "synthetic"}`;
    case "typing":
      return `typing:${entry.task.task_id}:${entry.task.status}`;
    default:
      return `entry:${entry.event?.sequence ?? "unknown"}`;
  }
}

function entrySignature(entry) {
  if (entry.kind === "tool") {
    return `${entryKey(entry)}:${entry.group.status}:${entry.group.events.length}`;
  }
  if (entry.kind === "status") return `${entryKey(entry)}:${entry.detail}`;
  if (entry.kind === "typing") {
    return `${entryKey(entry)}:${typingText(entry.task)}:${entry.task.queue_position ?? ""}`;
  }
  if (entry.kind === "codex") {
    return `${entryKey(entry)}:${entry.promptText.length}:${entry.truncated === true ? "t" : ""}`;
  }
  if (entry.kind === "opencode") {
    return `${entryKey(entry)}:${entry.truncated === true ? "t" : ""}`;
  }
  return entryKey(entry);
}

function renderMessageBody(entry, isCodex) {
  return [isCodex ? node("p", entry.text, "bubble-text") : renderMarkdown(entry.text)];
}

// Keep all recorded output, revealing another readable segment on each click.
function progressiveOutput(value, key) {
  const text = displayValue(value);
  const wrap = node("div", undefined, "progressive-output");
  const pre = node("pre", "", "tool-pre");
  const more = node("button", "", "expand-output");
  more.type = "button";
  let offset = 0;
  function reveal(end) {
    pre.append(document.createTextNode(text.slice(offset, end)));
    offset = end;
    state.outputOffsets.set(key, offset);
    more.hidden = offset >= text.length;
    more.textContent = `展开下一段 · 剩余 ${text.length - offset} 字`;
  }
  function nextEnd() {
    let end = Math.min(offset + 6000, text.length);
    let cursor = offset;
    for (let lines = 0; lines < 80; lines++) {
      const newline = text.indexOf("\n", cursor);
      if (newline === -1 || newline >= end) break;
      cursor = newline + 1;
      if (lines === 79) end = cursor;
    }
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return end;
  }
  reveal(Math.min(state.outputOffsets.get(key) || nextEnd(), text.length));
  more.addEventListener("click", () => reveal(nextEnd()));
  wrap.append(pre, more);
  return wrap;
}

function renderMessageEntry(entry, openKeys) {
  const isCodex = entry.kind === "codex";
  const row = node("article", undefined, `message-row ${isCodex ? "right" : "left"}`);
  row.dataset.key = entryKey(entry);
  row.append(
    node("span", isCodex ? "C" : "O", `avatar ${isCodex ? "codex" : "opencode"}`),
  );

  const wrap = node("div", undefined, "bubble-wrap");
  const meta = node("div", undefined, "message-meta");
  const time = node("time", formatTime(entry.event.timestamp));
  time.dateTime = entry.event.timestamp;
  meta.append(
    node("span", isCodex ? "Codex" : "OpenCode", "message-name"),
    node("span", entry.label, "message-label"),
    time,
  );

  const bubble = node("div", undefined, "bubble");
  for (const child of renderMessageBody(entry, isCodex, openKeys)) bubble.append(child);
  if (entry.truncated === true) {
    bubble.append(node("p", "记录已按日志策略截断。", "truncation-note"));
  }
  if (typeof entry.promptText === "string" && entry.promptText !== "") {
    const details = node("details", undefined, "bubble-detail");
    details.dataset.key = `${entryKey(entry)}:prompt`;
    details.open = openKeys.has(details.dataset.key);
    details.append(
      node("summary", "Bridge 实际发送的 Prompt"),
      node("pre", entry.promptText),
    );
    bubble.append(details);
  }

  wrap.append(meta, bubble);
  row.append(wrap);
  return row;
}

function renderToolEntry(entry, openKeys) {
  const group = entry.group;
  const row = node("article", undefined, "tool-row");
  row.dataset.key = entryKey(entry);
  row.append(node("span", "O", "avatar opencode"));

  const card = node("details", undefined, "tool-card");
  card.dataset.key = entryKey(entry);
  card.open = group.kind === "shell" || /^(bash|shell)$/.test(group.tool) || group.status === "failed" || openKeys.has(card.dataset.key);

  const summary = node("summary");
  summary.append(
    node("span", group.kind === "shell" ? "⌘" : "⚙", "tool-icon"),
    node("span", group.tool || "tool", "tool-name"),
    node(
      "span",
      group.status === "failed" ? "失败" : group.status === "completed" ? "完成" : "运行中",
      `tool-status ${group.status}`,
    ),
  );
  card.append(summary);

  const body = node("div", undefined, "tool-body");
  let hasContent = false;
  if (group.input !== null && group.input !== undefined) {
    body.append(node("div", "输入", "tool-label"), node("pre", displayValue(group.input), "tool-pre"));
    hasContent = true;
  }
  if (group.progress !== null && group.progress !== undefined) {
    body.append(node("div", "进度", "tool-label"), progressiveOutput(group.progress, `${entryKey(entry)}:progress`));
    hasContent = true;
  }
  if (group.output !== null && group.output !== undefined) {
    body.append(
      node("div", group.status === "failed" ? "错误" : "结果", "tool-label"),
      progressiveOutput(group.output, `${entryKey(entry)}:output`),
    );
    hasContent = true;
  }
  if (!hasContent) {
    body.append(node("pre", displayValue(group.events.map((event) => event.payload)), "tool-pre"));
  }
  card.append(body);

  row.append(card);
  return row;
}

function renderStatusEntry(entry) {
  const row = node("div", undefined, "status-row");
  row.dataset.key = entryKey(entry);
  const tone = entry.status === "completed"
    ? "success"
    : FAILURE_STATUSES.has(entry.status) ? "failure" : "";
  const pill = node("span", undefined, `status-pill ${tone}`.trim());
  pill.append(
    node("span", "", `dot ${entry.status}`),
    node("span", `第 ${entry.turn} 轮 · ${STATUS_LABELS[entry.status] ?? entry.status}`, "status-title"),
  );
  if (entry.detail !== "") pill.append(node("span", entry.detail, "status-detail"));
  row.append(pill);
  return row;
}

function renderErrorEntry(entry) {
  const row = node("article", undefined, "message-row left");
  row.dataset.key = entryKey(entry);
  row.append(node("span", "O", "avatar opencode"));

  const wrap = node("div", undefined, "bubble-wrap");
  const meta = node("div", undefined, "message-meta");
  const time = node("time", formatTime(entry.event.timestamp));
  time.dateTime = entry.event.timestamp;
  meta.append(
    node("span", "OpenCode", "message-name"),
    node("span", `执行错误 · 第 ${entry.turn} 轮`, "message-label"),
    time,
  );

  const bubble = node("div", undefined, "bubble error-bubble");
  bubble.append(node("p", entry.text, "bubble-text"));
  wrap.append(meta, bubble);
  row.append(wrap);
  return row;
}

function renderAuditEntry(entry, openKeys) {
  const details = node("details", undefined, "audit-row");
  details.dataset.key = entryKey(entry);
  details.open = openKeys.has(details.dataset.key);

  const summary = node("summary");
  const time = node("time", formatTime(entry.event.timestamp));
  time.dateTime = entry.event.timestamp;
  summary.append(
    node("span", `#${entry.event.sequence}`, "audit-seq"),
    node("span", entry.event.event_type, "audit-type"),
    node("span", entry.event.source, "audit-source"),
    time,
  );
  details.append(summary);
  details.append(node("pre", entry.text ?? displayValue(entry.event.payload)));
  return details;
}

function typingText(task) {
  switch (task.status) {
    case "queued":
      return task.queue_position ? `排队中 · 第 ${task.queue_position} 位` : "排队中";
    case "preparing":
      return "正在准备工作区";
    case "waiting_permission":
      return "等待授权";
    case "cancelling":
      return "正在停止";
    default:
      return "正在执行";
  }
}

function renderTypingEntry(entry) {
  const row = node("article", undefined, "message-row left typing-row");
  row.dataset.key = entryKey(entry);
  row.append(node("span", "O", "avatar opencode"));

  const wrap = node("div", undefined, "bubble-wrap");
  const meta = node("div", undefined, "message-meta");
  meta.append(
    node("span", "OpenCode", "message-name"),
    node("span", "处理中", "message-label"),
  );

  const bubble = node("div", undefined, "typing-bubble");
  const dots = node("span", undefined, "typing-dots");
  for (let index = 0; index < 3; index++) dots.append(node("i"));
  bubble.append(node("span", typingText(entry.task), "typing-text"), dots);

  wrap.append(meta, bubble);
  row.append(wrap);
  return row;
}

function renderEntry(entry, openKeys) {
  switch (entry.kind) {
    case "codex":
    case "opencode":
      return renderMessageEntry(entry, openKeys);
    case "tool":
      return renderToolEntry(entry, openKeys);
    case "status":
      return renderStatusEntry(entry);
    case "error":
      return renderErrorEntry(entry);
    case "audit":
      return renderAuditEntry(entry, openKeys);
    case "typing":
      return renderTypingEntry(entry);
    default:
      return node("p", "未知记录", "empty");
  }
}

function isNearBottom() {
  const transcript = $("transcript");
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
}

function renderPlaceholder(text) {
  const signature = `placeholder:${state.selectedRoot}:${text}`;
  if (signature === state.transcriptKey) return;
  state.transcriptKey = signature;
  $("chat").replaceChildren(node("p", text, "empty"));
  $("jump").hidden = true;
}

function renderTranscript() {
  if (state.selectedRoot === null) {
    renderPlaceholder(
      state.conversations.length > 0 ? "从左侧选择一个委派会话。" : "还没有委派会话。",
    );
    return;
  }

  const lineage = currentLineage();
  if (lineage.length === 0) {
    renderPlaceholder("正在读取会话…");
    return;
  }

  const merged = mergeEvents(lineage);
  const entries = buildEntries(lineage, merged);
  const signature = [
    state.selectedRoot,
    $("show-system").checked ? "audit" : "chat",
    lineage.map((task) => `${task.task_id}:${task.status}`).join("|"),
    entries.map(entrySignature).join("|"),
  ].join(";");
  if (signature === state.transcriptKey) return;

  const transcript = $("transcript");
  const nearBottom = isNearBottom();
  const previousTop = transcript.scrollTop;
  const openKeys = new Set(
    [...$("chat").querySelectorAll("details[open]")]
      .map((details) => details.dataset.key)
      .filter(Boolean),
  );

  state.transcriptKey = signature;
  if (entries.length === 0) {
    $("chat").replaceChildren(node("p", "正在读取会话…", "empty"));
  } else {
    const fragment = document.createDocumentFragment();
    for (const entry of entries) fragment.append(renderEntry(entry, openKeys));
    $("chat").replaceChildren(fragment);
  }

  if (state.firstRender) {
    state.firstRender = false;
    const latest = lineage.at(-1);
    requestAnimationFrame(() => {
      // Completed conversations open at the delegation so the whole exchange
      // can be read from the start; live tasks stay pinned to new activity.
      transcript.scrollTop = latest !== undefined && isTerminal(latest)
        ? 0
        : transcript.scrollHeight;
      $("jump").hidden = isNearBottom();
    });
  } else if (nearBottom) {
    requestAnimationFrame(() => {
      transcript.scrollTop = transcript.scrollHeight;
      $("jump").hidden = true;
    });
  } else {
    transcript.scrollTop = previousTop;
    $("jump").hidden = false;
  }
}

async function tick() {
  try {
    if (!key) throw new Error("链接缺少访问密钥，请运行 bridge viewer 重新打开。");
    const data = await api("/api/tasks");
    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.conversations = groupConversations(state.tasks);

    const focusedTaskId = typeof data.focused_task_id === "string"
      ? data.focused_task_id
      : null;
    const focusedTask = focusedTaskId
      ? state.tasks.find((task) => task.task_id === focusedTaskId)
      : undefined;
    state.serverFocusTask = focusedTaskId;
    state.serverFocusRoot = focusedTask ? taskRoot(focusedTask) : null;

    const latestRoot = state.conversations[0]?.root ?? null;
    const wantedRoot = state.serverFocusRoot ?? latestRoot;

    if (state.selectedRoot === null) {
      if (wantedRoot !== null) selectRoot(wantedRoot);
    } else if (
      $("follow").checked &&
      wantedRoot !== null &&
      wantedRoot !== state.selectedRoot
    ) {
      selectRoot(wantedRoot);
    }

    renderSidebar();
    renderHeader();

    const generation = state.generation;
    const lineage = currentLineage();
    for (const task of lineage) {
      if (isTerminal(task) && state.loadedTerminal.has(task.task_id)) continue;
      await fetchTaskEvents(task.task_id, generation);
      if (generation !== state.generation) break;
      if (isTerminal(task)) state.loadedTerminal.add(task.task_id);
    }
    renderTranscript();

    $("connection").textContent = "已连接本机 Bridge · 自动更新";
    $("connection").className = "connection";
    $("updated").textContent = `更新于 ${formatTime(new Date().toISOString())}`;
  } catch (error) {
    $("connection").textContent =
      `${error.message} · 将自动重连；Daemon 重启后可用 bridge viewer 获取新链接。`;
    $("connection").className = "connection error";
  } finally {
    setTimeout(tick, document.hidden ? 5000 : 1000);
  }
}

$("show-system").addEventListener("change", () => {
  state.transcriptKey = "";
  renderTranscript();
});

$("follow").addEventListener("change", () => {
  if ($("follow").checked && state.serverFocusRoot !== null) {
    selectRoot(state.serverFocusRoot);
  }
});

$("transcript").addEventListener("scroll", () => {
  $("jump").hidden = isNearBottom();
}, { passive: true });

$("jump").addEventListener("click", () => {
  $("transcript").scrollTo({
    top: $("transcript").scrollHeight,
    behavior: "smooth",
  });
  $("jump").hidden = true;
});

void tick();
