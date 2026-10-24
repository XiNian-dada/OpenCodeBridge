import { marked } from "marked";
import { decodeHTML } from "entities/decode";

// Parse CommonMark/GFM, but construct the DOM ourselves. Model output never
// becomes HTML, event handlers, CSS, or automatically fetched image URLs.
export function renderMarkdown(value, doc = document) {
  const element = (tag, text, className) => {
    const result = doc.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const container = element("div", undefined, "bubble-text markdown");
  const text = String(value ?? "");

  function link(href, title) {
    const anchor = element("a");
    try {
      const url = new URL(decodeHTML(href));
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return anchor;
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      if (title) anchor.title = decodeHTML(title);
    } catch { /* Relative paths and unsupported URLs stay readable text. */ }
    return anchor;
  }

  function codeBlock(token) {
    const block = element("div", undefined, "md-code-block");
    const header = element("div", undefined, "md-code-header");
    const language = (token.lang || "text").split(/\s+/)[0];
    const copy = element("button", "复制代码", "md-copy");
    copy.type = "button";
    copy.setAttribute("aria-label", `复制 ${language} 代码`);
    copy.setAttribute("aria-live", "polite");
    copy.addEventListener("click", async () => {
      try {
        const clipboard = doc.defaultView?.navigator?.clipboard;
        if (!clipboard?.writeText) throw new Error("Clipboard unavailable");
        await clipboard.writeText(token.text);
        copy.textContent = "已复制";
      } catch { copy.textContent = "请手动复制"; }
    });
    header.append(element("span", language), copy);
    const pre = element("pre");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", `${language} 代码`);
    pre.append(element("code", token.text));
    block.append(header, pre);
    return block;
  }

  function append(parent, tokens, depth = 0) {
    for (const token of tokens || []) {
      // Preserve even unusually deep/malformed output without a render crash.
      if (depth > 64) {
        parent.append(doc.createTextNode(token.raw || ""));
        continue;
      }
      const child = (tag) => {
        const result = element(tag);
        append(result, token.tokens, depth + 1);
        return result;
      };
      switch (token.type) {
        case "space": case "def": break;
        case "heading": parent.append(child(`h${Math.min(6, Math.max(1, token.depth))}`)); break;
        case "paragraph": parent.append(child("p")); break;
        case "blockquote": parent.append(child("blockquote")); break;
        case "strong": parent.append(child("strong")); break;
        case "em": parent.append(child("em")); break;
        case "del": parent.append(child("del")); break;
        case "br": parent.append(element("br")); break;
        case "hr": parent.append(element("hr")); break;
        case "codespan": parent.append(element("code", token.text)); break;
        case "code": parent.append(codeBlock(token)); break;
        case "escape": parent.append(doc.createTextNode(token.text)); break;
        case "html": parent.append(doc.createTextNode(token.raw)); break;
        case "text":
          if (token.tokens) append(parent, token.tokens, depth + 1);
          else parent.append(doc.createTextNode(decodeHTML(token.text)));
          break;
        case "link": {
          const anchor = link(token.href, token.title);
          append(anchor, token.tokens, depth + 1);
          parent.append(anchor);
          break;
        }
        case "image": {
          const anchor = link(token.href, token.title);
          anchor.className = "md-image-link";
          anchor.append(doc.createTextNode(`图片：${decodeHTML(token.text || "查看图片")}`));
          parent.append(anchor);
          break;
        }
        case "checkbox": {
          const checkbox = element("input");
          checkbox.type = "checkbox";
          checkbox.disabled = true;
          checkbox.checked = token.checked;
          checkbox.setAttribute("aria-label", token.checked ? "已完成" : "未完成");
          parent.append(checkbox, doc.createTextNode(" "));
          break;
        }
        case "list": {
          const list = element(token.ordered ? "ol" : "ul");
          if (token.ordered && token.start !== 1) list.start = token.start;
          for (const item of token.items) {
            const li = element("li", undefined, item.task ? "md-task" : undefined);
            append(li, item.tokens, depth + 1);
            list.append(li);
          }
          parent.append(list);
          break;
        }
        case "table": {
          const wrap = element("div", undefined, "md-table-wrap");
          wrap.tabIndex = 0;
          wrap.setAttribute("role", "region");
          wrap.setAttribute("aria-label", "Markdown 表格，可横向滚动");
          const table = element("table");
          const row = (cells, heading) => {
            const tr = element("tr");
            cells.forEach((cell, index) => {
              const td = element(heading ? "th" : "td");
              if (heading) td.scope = "col";
              const align = token.align[index];
              if (["left", "center", "right"].includes(align)) td.className = `md-align-${align}`;
              append(td, cell.tokens, depth + 1);
              tr.append(td);
            });
            return tr;
          };
          const head = element("thead");
          head.append(row(token.header, true));
          const body = element("tbody");
          for (const cells of token.rows) body.append(row(cells, false));
          table.append(head, body);
          wrap.append(table);
          parent.append(wrap);
          break;
        }
        default: parent.append(doc.createTextNode(token.raw || ""));
      }
    }
  }

  try {
    append(container, marked.lexer(text, { gfm: true, breaks: false }));
  } catch {
    container.replaceChildren(element("p", text, "md-fallback"));
  }
  return container;
}
