import { describe, expect, it } from "vitest";
import { OpenCodeHttpClient, OpenCodeHttpError } from "../../src/opencode/http-client.js";
import { startFakeOpenCode } from "../helpers/fake-opencode.js";

describe("OpenCode HTTP client", () => {
  it("reads info/models, creates a session, receives SSE events, and reads messages", async () => {
    const fake = await startFakeOpenCode("success");
    const client = new OpenCodeHttpClient({ baseUrl: fake.baseUrl, password: fake.password });
    try {
      const info = await client.info();
      expect(info.version).toBe("2.1.2");

      const models = await client.models();
      expect(models[0]).toMatchObject({ providerID: "fake", modelID: "echo" });

      const session = await client.createSession({
        title: "test",
        model: { providerID: "fake", id: "echo" },
      });
      expect(session.id).toMatch(/^ses_/);

      const controller = new AbortController();
      const seen: string[] = [];
      const stream = (async () => {
        for await (const event of client.events(controller.signal)) {
          seen.push(event.type);
          if (event.type === "session.idle") return;
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 30));
      await client.prompt(session.id, { text: "hello" });
      await stream;

      expect(seen).toContain("session.next.tool.called");
      expect(seen).toContain("session.idle");

      const messages = await client.messages(session.id);
      expect(messages.some((message) => message.type === "assistant")).toBe(true);

      const final = await client.session(session.id);
      expect(final.cost).toBe(0.003);
      expect(final.outcome).toBe("succeeded");
      expect(await client.interrupt(session.id)).toBe(false);
      controller.abort();
    } finally {
      await fake.close();
    }
  });

  it("rejects bad credentials", async () => {
    const fake = await startFakeOpenCode("success");
    try {
      const client = new OpenCodeHttpClient({ baseUrl: fake.baseUrl, password: "wrong" });
      await expect(client.info()).rejects.toBeInstanceOf(OpenCodeHttpError);
      await expect(client.info()).rejects.toMatchObject({ status: 401 });
    } finally {
      await fake.close();
    }
  });
});
