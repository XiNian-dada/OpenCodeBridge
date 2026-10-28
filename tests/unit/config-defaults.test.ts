import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";

it("defaults OpenCode to Go, disables legacy system-browser auto opening, and leaves task duration caller-controlled", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, JSON.stringify({ adapter: "opencode", viewer: { auto_open: true } }));
    const config = loadConfig({ path, env: {} });
    expect(config.models.default).toBe("opencode-go/deepseek-v4.1-flash");
    expect(config.models.allow).toEqual(["opencode-go/*"]);
    expect(config.viewer).toEqual({ enabled: true, auto_open: false });
    expect(config.scheduler.default_timeout_seconds).toBe(0);
    expect(config.scheduler.max_timeout_seconds).toBe(604_800);
    expect(config.opencode.compatibility).toBe("2.2.x");
    writeFileSync(path, JSON.stringify({ adapter: "opencode", models: { allow: ["other/model"], default: "other/model" } }));
    expect(loadConfig({ path, env: {} }).models.allow).toEqual(["other/model"]);
    writeFileSync(path, JSON.stringify({
      adapter: "opencode",
      scheduler: { default_timeout_seconds: 7200, max_timeout_seconds: 3600 },
    }));
    expect(() => loadConfig({ path, env: {} })).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
  } finally { unlinkSync(path); rmdirSync(dir); }
});
