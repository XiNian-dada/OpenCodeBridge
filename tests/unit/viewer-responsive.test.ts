import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const cssUrl = new URL("../../src/viewer/public/style.css", import.meta.url);

describe("viewer responsive styles", () => {
  it("enforces word-break and overflow containment on text and container elements", async () => {
    const css = await readFile(cssUrl, "utf8");

    // Container flexibility & min-width: 0 to prevent flex blowout
    expect(css).toMatch(/\.message-row\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.bubble\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.markdown\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.tool-card\s*\{[^}]*min-width:\s*0/);

    // Text wrapping & break-word across markdown and raw text
    expect(css).toMatch(/\.markdown\s*\{[^}]*word-break:\s*break-word/);
    expect(css).toMatch(/\.markdown p\s*\{[^}]*word-break:\s*break-word/);
    expect(css).toMatch(/\.markdown :is\(h1, h2, h3, h4, h5, h6\)\s*\{[^}]*word-break:\s*break-word/);
    expect(css).toMatch(/\.markdown a\[href\]\s*\{[^}]*word-break:\s*break-all/);

    // Tool output wrapping and no uncapped overflow
    expect(css).toMatch(/\.tool-pre\s*\{[^}]*word-break:\s*break-all/);
    expect(css).not.toMatch(/\.progressive-output \.tool-pre\s*\{[^}]*overflow:\s*visible/);
  });

  it("includes responsive breakpoints for narrow viewports and mobile side-panels", async () => {
    const css = await readFile(cssUrl, "utf8");

    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("@media (max-width: 480px)");

    // Under narrow screens, bubble and tool cards should not exceed container width minus avatar
    expect(css).toMatch(/@media \(max-width:\s*720px\)[^}]*\{[\s\S]*?\.bubble-wrap\s*\{[^}]*max-width:\s*calc\(100% - 34px\)/);
    expect(css).toMatch(/@media \(max-width:\s*720px\)[^}]*\{[\s\S]*?\.tool-card\s*\{[^}]*max-width:\s*calc\(100% - 34px\)/);

    // Topbar actions should wrap gracefully on narrow screens
    expect(css).toMatch(/@media \(max-width:\s*720px\)[^}]*\{[\s\S]*?\.topbar-actions\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  });
});
