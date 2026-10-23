import { describe, expect, it } from "vitest";
import { parseReviewFindings } from "../../src/core/findings.js";

describe("review findings parser", () => {
  it("parses a fenced findings block and validates confidence labels", () => {
    const text = `## Result\n\nOne issue found.\n\n\`\`\`json\n{"findings":[{"location":"src/a.ts:12","trigger":"empty input","evidence":"observed throw","confidence":"reproduced"}]}\n\`\`\``;
    const result = parseReviewFindings(text);
    expect(result.verified).toBe(true);
    expect(result.items).toEqual([
      {
        location: "src/a.ts:12",
        trigger: "empty input",
        evidence: "observed throw",
        confidence: "reproduced",
      },
    ]);
  });

  it("marks missing or malformed blocks as unverified", () => {
    expect(parseReviewFindings("No block here")).toMatchObject({
      verified: false,
      items: [],
    });
    expect(parseReviewFindings("```json\nnot-json\n```")).toMatchObject({
      verified: false,
      items: [],
    });
    expect(
      parseReviewFindings(
        '```json\n{"findings":[{"location":"a:1","trigger":"t","evidence":"e","confidence":"certain"}]}\n```',
      ),
    ).toMatchObject({ verified: false, items: [] });
  });
});
