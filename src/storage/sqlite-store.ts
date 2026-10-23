import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ApprovalRecord,
  BridgeEvent,
  TaskRecord,
  TaskStatus,
  TaskType,
  TaskUsage,
} from "../types.js";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    parent_task_id TEXT,
    root_task_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    opencode_task_id TEXT NOT NULL,
    idempotency_key TEXT,
    idempotency_fingerprint TEXT,
    task TEXT NOT NULL,
    repo_root TEXT NOT NULL,
    task_type TEXT NOT NULL,
    model TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_variant TEXT,
    read_only INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    session_id TEXT,
    server_pid INTEGER,
    worktree_path TEXT,
    worktree_git_dir TEXT,
    base_commit TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    error_code TEXT,
    error_message TEXT,
    result_summary TEXT,
    usage_json TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    stop_reason TEXT,
    cancel_requested_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
    ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_tasks_root ON tasks(root_task_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT,
    timestamp TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(task_id, sequence),
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_events_task_sequence ON events(task_id, sequence);

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    model TEXT,
    provider_id TEXT,
    worktree_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS worktrees (
    task_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    git_dir TEXT,
    base_commit TEXT,
    created_at TEXT NOT NULL,
    removed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS model_usage (
    task_id TEXT PRIMARY KEY,
    model_calls INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL,
    cost_known INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cleanup_records (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  `,
];

export class SqliteStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    const transaction = this.db.transaction(() => {
      for (let index = current; index < MIGRATIONS.length; index++) {
        const sql = MIGRATIONS[index];
        if (sql === undefined) continue;
        this.db.exec(sql);
        this.db
          .prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(index + 1, new Date().toISOString());
        this.db.pragma(`user_version = ${index + 1}`);
      }
    });
    transaction();
  }

  saveTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, parent_task_id, root_task_id, turn, opencode_task_id,
          idempotency_key, idempotency_fingerprint, task, repo_root, task_type,
          model, provider_id, model_id, model_variant, read_only, timeout_seconds,
          status, stage, session_id, server_pid, worktree_path, worktree_git_dir,
          base_commit, created_at, started_at, ended_at, error_code, error_message,
          result_summary, usage_json, last_event_sequence, stop_reason,
          cancel_requested_at, updated_at
        ) VALUES (
          @id, @parent_task_id, @root_task_id, @turn, @opencode_task_id,
          @idempotency_key, @idempotency_fingerprint, @task, @repo_root, @task_type,
          @model, @provider_id, @model_id, @model_variant, @read_only, @timeout_seconds,
          @status, @stage, @session_id, @server_pid, @worktree_path, @worktree_git_dir,
          @base_commit, @created_at, @started_at, @ended_at, @error_code, @error_message,
          @result_summary, @usage_json, @last_event_sequence, @stop_reason,
          @cancel_requested_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          parent_task_id = excluded.parent_task_id,
          root_task_id = excluded.root_task_id,
          turn = excluded.turn,
          opencode_task_id = excluded.opencode_task_id,
          idempotency_key = excluded.idempotency_key,
          idempotency_fingerprint = excluded.idempotency_fingerprint,
          task = excluded.task,
          repo_root = excluded.repo_root,
          task_type = excluded.task_type,
          model = excluded.model,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          model_variant = excluded.model_variant,
          read_only = excluded.read_only,
          timeout_seconds = excluded.timeout_seconds,
          status = excluded.status,
          stage = excluded.stage,
          session_id = excluded.session_id,
          server_pid = excluded.server_pid,
          worktree_path = excluded.worktree_path,
          worktree_git_dir = excluded.worktree_git_dir,
          base_commit = excluded.base_commit,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          result_summary = excluded.result_summary,
          usage_json = excluded.usage_json,
          last_event_sequence = excluded.last_event_sequence,
          stop_reason = excluded.stop_reason,
          cancel_requested_at = excluded.cancel_requested_at,
          updated_at = excluded.updated_at`,
      )
      .run({
        id: task.id,
        parent_task_id: task.parent_task_id,
        root_task_id: task.root_task_id,
        turn: task.turn,
        opencode_task_id: task.opencode_task_id,
        idempotency_key: task.idempotency_key,
        idempotency_fingerprint: task.idempotency_fingerprint,
        task: task.task,
        repo_root: task.repo_root,
        task_type: task.task_type,
        model: task.model,
        provider_id: task.provider_id,
        model_id: task.model_id,
        model_variant: task.model_variant,
        read_only: task.read_only ? 1 : 0,
        timeout_seconds: task.timeout_seconds,
        status: task.status,
        stage: task.stage,
        session_id: task.session_id,
        server_pid: task.server_pid,
        worktree_path: task.worktree_path,
        worktree_git_dir: task.worktree_git_dir,
        base_commit: task.base_commit,
        created_at: task.created_at,
        started_at: task.started_at,
        ended_at: task.ended_at,
        error_code: task.error_code,
        error_message: task.error_message,
        result_summary: task.result_summary,
        usage_json: JSON.stringify(task.usage),
        last_event_sequence: task.last_event_sequence,
        stop_reason: task.stop_reason,
        cancel_requested_at: task.cancel_requested_at,
        updated_at: new Date().toISOString(),
      });
  }

  appendEvent(event: BridgeEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
          (event_id, task_id, session_id, timestamp, sequence, source, event_type, payload_json)
         VALUES (@event_id, @task_id, @session_id, @timestamp, @sequence, @source, @event_type, @payload_json)`,
      )
      .run({
        event_id: event.event_id,
        task_id: event.task_id,
        session_id: event.session_id,
        timestamp: event.timestamp,
        sequence: event.sequence,
        source: event.source,
        event_type: event.event_type,
        payload_json: JSON.stringify(event.payload),
      });
  }

  saveSession(task: TaskRecord): void {
    if (task.session_id === null) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions(session_id, task_id, model, provider_id, worktree_path, created_at, updated_at)
         VALUES (@session_id, @task_id, @model, @provider_id, @worktree_path, @created_at, @updated_at)
         ON CONFLICT(session_id) DO UPDATE SET
           task_id = excluded.task_id,
           model = excluded.model,
           provider_id = excluded.provider_id,
           worktree_path = excluded.worktree_path,
           updated_at = excluded.updated_at`,
      )
      .run({
        session_id: task.session_id,
        task_id: task.id,
        model: task.model,
        provider_id: task.provider_id,
        worktree_path: task.worktree_path,
        created_at: now,
        updated_at: now,
      });
  }

  saveWorktree(task: TaskRecord): void {
    if (task.worktree_path === null) return;
    this.db
      .prepare(
        `INSERT INTO worktrees(task_id, path, git_dir, base_commit, created_at)
         VALUES (@task_id, @path, @git_dir, @base_commit, @created_at)
         ON CONFLICT(task_id) DO UPDATE SET
           path = excluded.path,
           git_dir = excluded.git_dir,
           base_commit = excluded.base_commit`,
      )
      .run({
        task_id: task.id,
        path: task.worktree_path,
        git_dir: task.worktree_git_dir,
        base_commit: task.base_commit,
        created_at: new Date().toISOString(),
      });
  }

  saveUsage(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_usage(
          task_id, model_calls, input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, cost_known, updated_at
        ) VALUES (
          @task_id, @model_calls, @input_tokens, @output_tokens, @reasoning_tokens,
          @cache_read_tokens, @cache_write_tokens, @cost_usd, @cost_known, @updated_at
        )
        ON CONFLICT(task_id) DO UPDATE SET
          model_calls = excluded.model_calls,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          cost_usd = excluded.cost_usd,
          cost_known = excluded.cost_known,
          updated_at = excluded.updated_at`,
      )
      .run({
        task_id: task.id,
        model_calls: task.usage.model_calls,
        input_tokens: task.usage.input_tokens,
        output_tokens: task.usage.output_tokens,
        reasoning_tokens: task.usage.reasoning_tokens,
        cache_read_tokens: task.usage.cache_read_tokens,
        cache_write_tokens: task.usage.cache_write_tokens,
        cost_usd: task.usage.cost_usd,
        cost_known: task.usage.cost_known ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
  }

  saveApproval(approval: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals(id, kind, payload_json, created_at, consumed_at)
         VALUES (@id, @kind, @payload_json, @created_at, @consumed_at)
         ON CONFLICT(id) DO UPDATE SET consumed_at = excluded.consumed_at`,
      )
      .run({
        id: approval.id,
        kind: approval.kind,
        payload_json: JSON.stringify(approval.payload),
        created_at: approval.created_at,
        consumed_at: approval.consumed_at,
      });
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return {
      id: String(row.id),
      kind: String(row.kind),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      created_at: String(row.created_at),
      consumed_at: row.consumed_at === null ? null : String(row.consumed_at),
    };
  }

  consumeApproval(id: string): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  saveCleanupRecord(record: {
    id: string;
    kind: string;
    path: string | null;
    result: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO cleanup_records(id, kind, path, result, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.kind, record.path, record.result, new Date().toISOString());
  }

  loadTasks(): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToTask);
  }

  loadEvents(): BridgeEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY task_id ASC, sequence ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      event_id: String(row.event_id),
      task_id: String(row.task_id),
      session_id: row.session_id === null ? null : String(row.session_id),
      timestamp: String(row.timestamp),
      sequence: Number(row.sequence),
      source: row.source as BridgeEvent["source"],
      event_type: String(row.event_type),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export function openSqliteStore(path: string): SqliteStore {
  return new SqliteStore(path);
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    parent_task_id: row.parent_task_id === null ? null : String(row.parent_task_id),
    root_task_id: String(row.root_task_id),
    turn: Number(row.turn),
    opencode_task_id: String(row.opencode_task_id),
    idempotency_key: row.idempotency_key === null ? null : String(row.idempotency_key),
    idempotency_fingerprint:
      row.idempotency_fingerprint === null ? null : String(row.idempotency_fingerprint),
    task: String(row.task),
    repo_root: String(row.repo_root),
    task_type: String(row.task_type) as TaskType,
    model: String(row.model),
    provider_id: String(row.provider_id),
    model_id: String(row.model_id),
    model_variant: row.model_variant === null ? null : String(row.model_variant),
    read_only: Number(row.read_only) === 1,
    timeout_seconds: Number(row.timeout_seconds),
    status: String(row.status) as TaskStatus,
    stage: String(row.stage),
    session_id: row.session_id === null ? null : String(row.session_id),
    server_pid: row.server_pid === null ? null : Number(row.server_pid),
    worktree_path: row.worktree_path === null ? null : String(row.worktree_path),
    worktree_git_dir: row.worktree_git_dir === null ? null : String(row.worktree_git_dir),
    base_commit: row.base_commit === null ? null : String(row.base_commit),
    created_at: String(row.created_at),
    started_at: row.started_at === null ? null : String(row.started_at),
    ended_at: row.ended_at === null ? null : String(row.ended_at),
    error_code: row.error_code === null ? null : String(row.error_code),
    error_message: row.error_message === null ? null : String(row.error_message),
    result_summary: row.result_summary === null ? null : String(row.result_summary),
    usage: JSON.parse(String(row.usage_json)) as TaskUsage,
    last_event_sequence: Number(row.last_event_sequence),
    stop_reason:
      row.stop_reason === null
        ? null
        : (String(row.stop_reason) as "abort" | "timeout" | "budget"),
    cancel_requested_at:
      row.cancel_requested_at === null ? null : String(row.cancel_requested_at),
  };
}
