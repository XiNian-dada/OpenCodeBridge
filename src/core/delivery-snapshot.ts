import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffResult } from "../git/diff-manager.js";
import type { TaskUsage } from "../types.js";

export interface DeliverySnapshot {
  version: 1;
  task_id: string;
  captured_at: string;
  diff: DiffResult;
  usage: TaskUsage;
  session_usage: TaskUsage | null;
}

export function deliverySnapshotPath(dataDir: string, taskId: string): string {
  return join(dataDir, "tasks", taskId, "delivery.json");
}

export async function writeDeliverySnapshot(
  dataDir: string,
  snapshot: DeliverySnapshot,
): Promise<boolean> {
  const path = deliverySnapshotPath(dataDir, snapshot.task_id);
  const directory = join(dataDir, "tasks", snapshot.task_id);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // A delivery snapshot is immutable. Never let a later capture rewrite the
  // worker's completion evidence.
  try {
    await stat(path);
    return false;
  } catch {
    // No snapshot yet.
  }

  const temp = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temp, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
    created = true;
    await rename(temp, path);
    return true;
  } finally {
    if (created) await unlink(temp).catch(() => undefined);
  }
}

export async function readDeliverySnapshot(
  dataDir: string,
  taskId: string,
): Promise<DeliverySnapshot | null> {
  try {
    const parsed = JSON.parse(
      await readFile(deliverySnapshotPath(dataDir, taskId), "utf8"),
    ) as Partial<DeliverySnapshot>;
    if (
      parsed.version !== 1 ||
      parsed.task_id !== taskId ||
      typeof parsed.captured_at !== "string" ||
      typeof parsed.diff !== "object" ||
      parsed.diff === null ||
      typeof parsed.usage !== "object" ||
      parsed.usage === null
    ) {
      return null;
    }
    return {
      version: 1,
      task_id: parsed.task_id,
      captured_at: parsed.captured_at,
      diff: parsed.diff as DiffResult,
      usage: parsed.usage as TaskUsage,
      session_usage:
        typeof parsed.session_usage === "object" && parsed.session_usage !== null
          ? (parsed.session_usage as TaskUsage)
          : null,
    };
  } catch {
    return null;
  }
}
