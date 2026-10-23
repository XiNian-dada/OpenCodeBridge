export interface OpenCodeInfo {
  version: string;
  pid: number;
  urls: string[];
  paths?: { tmp?: string };
  capabilities?: Record<string, unknown> | null;
}

export interface OpenCodeModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
  tier?: { type: "context"; size: number };
}

export interface OpenCodeModel {
  id: string;
  modelID: string;
  providerID: string;
  name?: string;
  package?: string;
  settings?: {
    apiKey?: unknown;
    baseURL?: unknown;
    provider?: unknown;
    [key: string]: unknown;
  };
  cost?: OpenCodeModelCost[];
  variants?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OpenCodeSessionModel {
  id: string;
  providerID: string;
  variant?: string;
}

export interface OpenCodeSessionTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OpenCodeSessionTime {
  created: number;
  updated: number;
  idle?: number;
  archived?: number;
}

export interface OpenCodeSession {
  id: string;
  title?: string;
  model?: OpenCodeSessionModel;
  cost?: number;
  tokens?: OpenCodeSessionTokens;
  time?: OpenCodeSessionTime;
  outcome?: "succeeded" | "failed" | "interrupted";
  location?: { directory: string };
  [key: string]: unknown;
}

export type OpenCodeMessage = Record<string, unknown>;

export interface OpenCodeEvent {
  id?: string;
  type: string;
  data: unknown;
}

export interface OpenCodeCreateSessionInput {
  title?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  permissions?: unknown;
}

export interface OpenCodePromptInput {
  text: string;
  resume?: boolean;
}
