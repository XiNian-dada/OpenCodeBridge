import { it, expect } from "vitest";
import { writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHarness } from "../helpers/fixtures.js";
import { ViewerSettings } from "../../src/viewer/settings.js";
import { TaskViewer } from "../../src/viewer/server.js";
import { createLogger } from "../../src/logging.js";

it("authenticates settings, blocks CSRF, never echoes keys, and updates durable and live defaults", async () => {
  const h = await createHarness();
  const path = join(h.repoRoot, "bridge-config.json");
  await writeFile(path, JSON.stringify({ models: h.config.models, security: { allowed_repo_roots: [h.repoRoot] } }));
  const viewer = new TaskViewer({ service: h.services.service, logger: createLogger("silent"), settings: new ViewerSettings(h.config, path) });
  try {
    await viewer.listen();
    const url = new URL(viewer.info().url!);
    const endpoint = `${url.origin}/api/settings`;
    const headers = { authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("key")}`, origin: url.origin, "content-type": "application/json" };
    const body = JSON.stringify({ default_model: "mock/echo", go_api_key: "test-private-key" });
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { method: "PUT", headers: { ...headers, origin: "https://evil.invalid" }, body })).status).toBe(403);
    expect((await fetch(endpoint, { method: "PUT", headers: { authorization: headers.authorization, "content-type": "application/json" }, body })).status).toBe(403);
    expect((await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify({ default_model: "forbidden/model" }) })).status).toBe(400);
    const saved = await fetch(endpoint, { method: "PUT", headers, body });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("test-private-key");
    const info = await (await fetch(endpoint, { headers })).json();
    expect(JSON.stringify(info)).not.toContain("test-private-key");
    expect(info).toMatchObject({ go_key_configured: true, credential_valid: false });
    expect(h.config.opencode.go_api_key).toBe("test-private-key");
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.opencode.go_api_key).toBe("test-private-key");
    expect(raw.security.allowed_repo_roots).toEqual([h.repoRoot]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await fetch(endpoint, { method: "PUT", headers, body: JSON.stringify({ default_model: "mock/echo", clear_go_api_key: true }) })).status).toBe(200);
    expect(h.config.opencode.go_api_key).toBeUndefined();
  } finally { await viewer.close(); await h.cleanup(); }
});
