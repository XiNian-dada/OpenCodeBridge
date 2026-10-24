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

export function isProviderPattern(value: string): boolean {
  return /^[^/*#]+\/\*$/.test(value);
}

function matches(entries: string[], model: string, base: string): boolean {
  return entries.some((entry) => entry === model || entry === base ||
    (isProviderPattern(entry) && base.startsWith(entry.slice(0, -1))));
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

    if (base.includes("*")) {
      throw new BridgeError("INVALID_ARGUMENT", "A concrete provider/model ID is required");
    }
    const allowed = matches(this.config.allow, model, base);
    if (!allowed) {
      throw new BridgeError("MODEL_NOT_ALLOWED", `Model is not in the allowlist: ${model}`, {
        details: { model, allow: this.config.allow },
      });
    }

    const expensive = matches(this.config.expensive, model, base);
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
