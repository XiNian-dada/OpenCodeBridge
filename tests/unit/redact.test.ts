import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/core/redact.js";

describe("Redactor", () => {
  it("redacts sensitive keys recursively", () => {
    const redactor = new Redactor({ maxStringChars: 1000 });
    const redacted = redactor.redact({
      authorization: "Bearer secret",
      nested: {
        api_key: "sk-secret",
        password: "hunter2",
        env: { HOME: "/Users/example" },
        safe: "keep me",
      },
      list: [{ token: "abc" }],
    }) as Record<string, unknown>;

    expect(redacted.authorization).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).api_key).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).env).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).safe).toBe("keep me");
    expect((redacted.list as Array<Record<string, unknown>>)[0]?.token).toBe("[REDACTED]");
  });

  it("truncates long strings and deep structures", () => {
    const redactor = new Redactor({ maxStringChars: 5, maxDepth: 2 });
    expect(redactor.redact("abcdefgh")).toBe("abcde…[truncated 3 chars]");
    expect(redactor.redact({ a: { b: { c: 1 } } })).toEqual({ a: { b: "[MAX_DEPTH]" } });
  });

  it("handles circular references", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(new Redactor({ maxStringChars: 10 }).redact(value)).toEqual({ self: "[CIRCULAR]" });
  });
});
