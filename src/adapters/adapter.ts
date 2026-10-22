import type { BridgeEvent, TaskRecord, TaskSource, TaskUsage } from "../types.js";

export interface AdapterProbe {
  name: string;
  version: string;
  compatible: boolean;
  details?: Record<string, unknown>;
}

export interface AdapterSession {
  id: string;
  model: string;
  provider_id: string;
  worktree_path: string | null;
}

export interface AdapterEventInput {
  source: TaskSource;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface AdapterContext {
  signal: AbortSignal;
  onSession(session: AdapterSession): void;
  emit(event: AdapterEventInput): void;
}

export interface AdapterRunResult {
  summary: string;
  usage?: TaskUsage;
  stopped?: boolean;
  tests?: Record<string, unknown>;
}

export interface AbortResult {
  stopped: boolean;
  detail?: string;
}

export interface AgentAdapter {
  readonly name: string;
  readonly supportsWrites: boolean;
  readonly requiresIsolatedWorktree: boolean;
  probe(): Promise<AdapterProbe>;
  buildPrompt(task: TaskRecord): string;
  start(task: TaskRecord, prompt: string, context: AdapterContext): Promise<AdapterRunResult>;
  abort(session: AdapterSession): Promise<AbortResult>;
  shutdown?(): Promise<void>;
}

export function eventToAdapterInput(event: BridgeEvent): AdapterEventInput {
  return {
    source: event.source,
    event_type: event.event_type,
    payload: event.payload,
  };
}
