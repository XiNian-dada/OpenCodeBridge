import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { BridgeConfig } from "../config.js";
import { ModelPolicy } from "../policy/model-policy.js";
import { consoleCredential } from "../opencode/console-credential.js";
import { BridgeError } from "../errors.js";

const Input = z.object({
  default_model: z.string().trim().min(1).max(256),
  go_api_key: z.string().trim().min(1).max(4096).optional(),
  clear_go_api_key: z.boolean().optional(),
}).strict();

export class ViewerSettings {
  private saving = false;
  constructor(private readonly config: BridgeConfig, private readonly path: string) {}

  async read(): Promise<Record<string, unknown>> {
    const configured = !!this.config.opencode.go_api_key;
    const credential = configured || this.config.adapter === "mock" ? null : await consoleCredential(this.config.opencode.binary);
    return {
      default_model: this.config.models.default, allowed_models: this.config.models.allow,
      go_key_configured: configured,
      credential_source: configured ? "独立 Go API Key" : credential ? "现有 OpenCode Console 登录" : "尚未发现 OpenCode Console 登录",
      credential_valid: !!(credential && (credential.expires === null || credential.expires > Date.now())),
      config_path: this.path,
    };
  }

  async save(input: unknown): Promise<void> {
    const parsed = Input.safeParse(input);
    if (!parsed.success) throw new BridgeError("INVALID_ARGUMENT", "配置格式无效");
    const data = parsed.data;
    if (data.go_api_key && data.clear_go_api_key) throw new BridgeError("INVALID_ARGUMENT", "不能同时设置和清除 Key");
    new ModelPolicy(this.config.models).resolve(data.default_model);
    if (this.saving) throw new BridgeError("INVALID_ARGUMENT", "正在保存，请稍后重试");
    this.saving = true;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      const models = { ...(raw.models as object), default: data.default_model };
      const opencode = { ...(raw.opencode as Record<string, unknown>) };
      if (data.go_api_key) opencode.go_api_key = data.go_api_key;
      if (data.clear_go_api_key) delete opencode.go_api_key;
      await writeFile(temp, JSON.stringify({ ...raw, models, opencode }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      created = true;
      await rename(temp, this.path);
      this.config.models.default = data.default_model;
      if (data.go_api_key) this.config.opencode.go_api_key = data.go_api_key;
      if (data.clear_go_api_key) delete this.config.opencode.go_api_key;
    } finally { this.saving = false; if (created) await unlink(temp).catch(() => undefined); }
  }
}
