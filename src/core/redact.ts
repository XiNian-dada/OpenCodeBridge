export const DEFAULT_SENSITIVE_KEY_PATTERN =
  /authorization|api[-_]?key|secret|password|cookie|credential|(^|[._-])(access|refresh|id|auth)?[._-]?token($|[._-])|^env$/i;

export interface RedactorOptions {
  sensitiveKeyPattern?: RegExp;
  maxStringChars: number;
  maxDepth?: number;
  maxArrayItems?: number;
}

export class Redactor {
  private readonly sensitiveKeyPattern: RegExp;
  private readonly maxStringChars: number;
  private readonly maxDepth: number;
  private readonly maxArrayItems: number;

  constructor(options: RedactorOptions) {
    this.sensitiveKeyPattern = options.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;
    this.maxStringChars = options.maxStringChars;
    this.maxDepth = options.maxDepth ?? 8;
    this.maxArrayItems = options.maxArrayItems ?? 100;
  }

  redact(value: unknown): unknown {
    return this.visit(value, 0, new WeakSet<object>());
  }

  private visit(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.truncate(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "undefined") return undefined;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return String(value);

    if (depth >= this.maxDepth) return "[MAX_DEPTH]";

    const object = value as object;
    if (seen.has(object)) return "[CIRCULAR]";
    seen.add(object);

    if (Array.isArray(value)) {
      const items = value.slice(0, this.maxArrayItems).map((item) => this.visit(item, depth + 1, seen));
      if (value.length > this.maxArrayItems) items.push(`[TRUNCATED ${value.length - this.maxArrayItems} ITEMS]`);
      return items;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = this.sensitiveKeyPattern.test(key) ? "[REDACTED]" : this.visit(entry, depth + 1, seen);
    }
    return result;
  }

  private truncate(value: string): string {
    if (value.length <= this.maxStringChars) return value;
    return `${value.slice(0, this.maxStringChars)}…[truncated ${value.length - this.maxStringChars} chars]`;
  }
}
