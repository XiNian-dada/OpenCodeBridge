import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { sanitizeEnvironment } from "./process.js";

const exec = promisify(execFile);
export interface ConsoleCredential { token: string; expires: number | null; orgID: string | null }

/** Trusted parent only. Never expose the result to workers, viewers or logs. */
export function readConsoleCredential(path: string): ConsoleCredential | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT value FROM credential WHERE integration_id = 'opencode' AND active = 1 LIMIT 2").all() as Array<{ value: string }>;
    if (rows.length !== 1) return null;
    const value = JSON.parse(rows[0]!.value) as Record<string, unknown>;
    if (value.type === "oauth" && typeof value.expires !== "number") return null;
    const token = value.type === "oauth" ? value.access : value.type === "key" ? value.key : null;
    if (typeof token !== "string" || !token) return null;
    const metadata = value.metadata as Record<string, unknown> | undefined;
    // Only the official Console credential may be sent to the official Go endpoint.
    const server = metadata?.server;
    if (server !== undefined && server !== "https://opencode.ai/console" && server !== "https://console.opencode.ai") return null;
    return { token, expires: typeof value.expires === "number" ? value.expires : null,
      orgID: typeof metadata?.orgID === "string" ? metadata.orgID : null };
  } catch { return null; }
  finally { db?.close(); }
}

export async function consoleCredential(binary: string): Promise<ConsoleCredential | null> {
  try {
    const { stdout } = await exec(binary, ["debug", "paths"], {
      env: sanitizeEnvironment(process.env), timeout: 5000, maxBuffer: 64 * 1024,
    });
    const path = process.env.OPENCODE_DB || /^db\s+(.+)$/m.exec(stdout)?.[1]?.trim();
    return path ? readConsoleCredential(path) : null;
  } catch { return null; }
}
