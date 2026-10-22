import type { BridgeConfig } from "../config.js";
import { BridgeError } from "../errors.js";

export interface ResolvedModel {
  model: string;
  provider_id: string;
  model_id: string;
  variant: string | null;
  expensive: boolean;
  cost_known: boolean;
}

export class ModelPolicy {
  constructor(private readonly config: BridgeConfig["models"]) {}

  resolve(requested?: string): ResolvedModel {
    const model = requested?.trim() || this.config.default;
    if (model === null || model === undefined || model === "") {
      throw new BridgeError(
        "MODEL_NOT_ALLOWED",
        "No model was requested and no default model is configured",
        { details: { allow: this.config.allow } },
      );
    }

    const hashIndex = model.indexOf("#");
    const base = hashIndex === -1 ? model : model.slice(0, hashIndex);
    const variant = hashIndex === -1 ? null : model.slice(hashIndex + 1);

    const allowed = this.config.allow.includes(model) || this.config.allow.includes(base);
    if (!allowed) {
      throw new BridgeError("MODEL_NOT_ALLOWED", `Model is not in the allowlist: ${model}`, {
        details: { model, allow: this.config.allow },
      });
    }

    const expensive = this.config.expensive.includes(model) || this.config.expensive.includes(base);
    if (expensive && !this.config.allow_expensive) {
      throw new BridgeError(
        "MODEL_UPGRADE_REQUIRED",
        `Model ${model} is marked expensive and requires explicit user authorization`,
        { details: { model } },
      );
    }

    const slash = base.indexOf("/");
    if (slash <= 0 || slash === base.length - 1) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `Model must use the form provider/model: ${model}`,
        { details: { model } },
      );
    }

    return {
      model,
      provider_id: base.slice(0, slash),
      model_id: base.slice(slash + 1),
      variant,
      expensive,
      cost_known: false,
    };
  }
}
