export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_CONFIG",
  "INVALID_STATE_TRANSITION",
  "TASK_NOT_FOUND",
  "TASK_NOT_TERMINAL",
  "TASK_BUSY",
  "TASK_TIMEOUT",
  "TASK_ABORTED",
  "TASK_ABORT_FAILED",
  "QUEUE_FULL",
  "IDEMPOTENCY_CONFLICT",
  "MODEL_NOT_ALLOWED",
  "MODEL_UNAVAILABLE",
  "MODEL_UPGRADE_REQUIRED",
  "MODEL_GATEWAY_UNAVAILABLE",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_PAUSED",
  "REGION_RESTRICTED",
  "BUDGET_EXCEEDED",
  "REPO_NOT_FOUND",
  "REPO_NOT_ALLOWED",
  "REPO_NOT_GIT",
  "WORKTREE_CREATE_FAILED",
  "CONTEXT_SNAPSHOT_FAILED",
  "PERMISSION_DENIED",
  "SANDBOX_UNAVAILABLE",
  "OPENCODE_UNAVAILABLE",
  "OPENCODE_INCOMPATIBLE",
  "OPENCODE_SPAWN_FAILED",
  "SESSION_LOST",
  "ADAPTER_ERROR",
  "NOT_IMPLEMENTED",
  "STORAGE_ERROR",
  "DAEMON_UNAVAILABLE",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_CONSUMED",
  "CLEANUP_FAILED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BridgeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof BridgeError;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof BridgeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: String(error),
    retryable: false,
  };
}
