import { describe, expect, it } from "vitest";
import { parseHTML, type HTMLInputElement } from "linkedom";

const rendererUrl = new URL("../../src/viewer/public/markdown.js", import.meta.url);
const { renderMarkdown } = await import(rendererUrl.href);

function render(markdown: string) {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  return renderMarkdown(markdown, document) as ReturnType<typeof document.createElement>;
}

describe("viewer Markdown DOM rendering", () => {
  it("renders GFM tables with alignment, formatted cells and escaped pipes", () => {
    const result = render("| 字段 | 值 |\n| :--- | ---: |\n| **名称** | `a\\|b` |\n| 状态 | 完成 | ");
    expect(result.querySelectorAll("table")).toHaveLength(1);
    expect(result.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(result.querySelector("td strong")?.textContent).toBe("名称");
    expect(result.querySelector("td code")?.textContent).toBe("a|b");
    expect(result.querySelectorAll("th")[1]?.className).toBe("md-align-right");
    expect(result.querySelector(".md-table-wrap")?.getAttribute("tabindex")).toBe("0");
  });

  it("preserves heading levels, nested lists, ordered starts, quotes and task lists", () => {
    const result = render("# **标题**\n\n## 二级\n\n> 引用\n>\n> - 子项\n\n3. 第三项\n   - 嵌套\n\n- [x] 已完成\n- [ ] 待完成\n\n---\n\n###### 六级");
    expect(result.querySelector("h1 strong")?.textContent).toBe("标题");
    expect(result.querySelector("h2")?.textContent).toBe("二级");
    expect(result.querySelector("h6")?.textContent).toBe("六级");
    expect(result.querySelector("blockquote ul li")?.textContent).toBe("子项");
    expect(result.querySelector("ol")?.start).toBe(3);
    expect(result.querySelector("ol li ul li")?.textContent).toBe("嵌套");
    expect([...result.querySelectorAll<HTMLInputElement>("input")].map((input) => [input.checked, input.disabled])).toEqual([[true, true], [false, true]]);
    expect(result.querySelector("hr")).not.toBeNull();
  });

  it("handles entities, escapes, inline formatting, references, autolinks and hard breaks", () => {
    const result = render("*斜体* ~~旧值~~ &amp; &#x4e2d; \\*原文\\* `&amp; <x>`\n软换行  \n硬换行\n\n[文档][ref] 与 https://example.org\n\n[ref]: https://example.com/docs \"说明\"");
    expect(result.querySelector("em")?.textContent).toBe("斜体");
    expect(result.querySelector("del")?.textContent).toBe("旧值");
    expect(result.textContent).toContain("& 中 *原文*");
    expect(result.querySelector("code")?.textContent).toBe("&amp; <x>");
    expect(result.querySelectorAll("br")).toHaveLength(1);
    expect(result.querySelectorAll("a[href]")).toHaveLength(2);
    expect(result.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(result.querySelector("a")?.getAttribute("title")).toBe("说明");
  });

  it("retains complete fenced and indented code with language labels and copy controls", () => {
    const code = Array.from({ length: 180 }, (_, i) => `console.log(${i}, '<tag>&amp;');`).join("\n");
    const result = render(`~~~~typescript\n${code}\n~~~~\n\n    indented <x>\n`);
    expect(result.querySelector("pre code")?.textContent).toBe(code);
    expect(result.querySelectorAll("pre code")[1]?.textContent).toBe("indented <x>\n");
    expect(result.querySelector(".md-code-header span")?.textContent).toBe("typescript");
    expect(result.querySelectorAll("button.md-copy")).toHaveLength(2);
    expect(result.querySelector("tag")).toBeNull();
    expect(render("```json\n{\"streaming\":true}").querySelector("pre code")?.textContent).toBe('{"streaming":true}');
  });

  it("keeps raw HTML inert and blocks executable or ambiguous links without fetching images", () => {
    const result = render('<script>alert(1)</script>\n\n<img src="https://example.org/track" onerror="alert(1)">\n\n[坏](javascript:alert%281%29) [实体](javascript&colon;alert%281%29) [数据](data:text/html,boom) [文件](file:///etc/passwd) [相对](/api/settings) ![截图](https://example.org/track.png)\n\n<https://example.org>');
    expect(result.querySelectorAll("script,img,iframe,style,object,embed")).toHaveLength(0);
    expect(result.textContent).toContain('<script>alert(1)</script>');
    expect([...result.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))).toEqual(["https://example.org/track.png", "https://example.org/"]);
    expect(result.querySelector(".md-image-link")?.textContent).toBe("图片：截图");
    expect(result.querySelectorAll("[onerror],[onclick],[style]")).toHaveLength(0);
  });

  it("shows malformed and deeply nested content instead of dropping the message", () => {
    expect(render("**尚未结束\n\n| a | b\n这也是原文").textContent).toContain("这也是原文");
    const result = render(`${"> ".repeat(90)}最深内容`);
    expect(result.textContent).toContain("最深内容");
  });
});
