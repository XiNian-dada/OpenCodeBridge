import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConsoleCredential } from "../../src/opencode/console-credential.js";

it("reads only the active official Console credential without changing the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-auth-"));
  const path = join(dir, "auth.db");
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)");
    const put = db.prepare("INSERT INTO credential VALUES (?, ?, ?)");
    put.run("unrelated", 1, JSON.stringify({ type: "key", key: "unrelated" }));
    put.run("opencode", 0, JSON.stringify({ type: "key", key: "inactive" }));
    put.run("opencode", 1, JSON.stringify({ type: "oauth", access: "active-secret", expires: Date.now() + 60000, metadata: { server: "https://opencode.ai/console", orgID: "org-test" } }));
    expect(readConsoleCredential(path)).toMatchObject({ token: "active-secret", orgID: "org-test" });
    expect(db.prepare("SELECT count(*) AS n FROM credential").get()).toEqual({ n: 3 });
    db.prepare("UPDATE credential SET value = ? WHERE integration_id = 'opencode' AND active = 1").run(JSON.stringify({ type: "key", key: "other-server", metadata: { server: "https://unrelated.invalid" } }));
    expect(readConsoleCredential(path)).toBeNull();
    expect(readConsoleCredential(join(dir, "missing"))).toBeNull();
  } finally { db.close(); unlinkSync(path); rmdirSync(dir); }
});
