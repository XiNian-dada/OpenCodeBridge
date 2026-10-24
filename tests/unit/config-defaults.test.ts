import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";

it("defaults OpenCode to Go and disables legacy system-browser auto opening", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, JSON.stringify({ adapter: "opencode", viewer: { auto_open: true } }));
    const config = loadConfig({ path, env: {} });
    expect(config.models.default).toBe("opencode-go/deepseek-v4.1-flash");
    expect(config.models.allow).toEqual(["opencode-go/*"]);
    expect(config.viewer).toEqual({ enabled: true, auto_open: false });
    writeFileSync(path, JSON.stringify({ adapter: "opencode", models: { allow: ["other/model"], default: "other/model" } }));
    expect(loadConfig({ path, env: {} }).models.allow).toEqual(["other/model"]);
  } finally { unlinkSync(path); rmdirSync(dir); }
});
