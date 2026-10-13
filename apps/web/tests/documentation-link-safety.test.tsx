import { describe, expect, it } from "bun:test";
import { act, render } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/core";
import { MarkdownContent } from "../src/features/inspector/documentation/markdown-content";
import { renderDocumentationEditor, typeInEditor } from "./support/editor";

/** Schemes that make a browser run or embed something. Written as a scheme name, without its `:`. */
const unsafeSchemes = ["javascript", "data", "vbscript", "file"];

/**
 * Returns whether `url` carries one of `unsafeSchemes`. The scheme is read the way a browser reads it: character
 * references decoded, whitespace and control characters removed, and the scheme matched case-insensitively. So
 * `java&#9;script:alert(1)` and `java\tscript:alert(1)` are both judged as `javascript:`.
 */
function isUnsafeUrl(url: string) {
  const decoded = url.replace(/&(?:#[0-9]{1,7}|#[xX][0-9a-f]{1,6});?/g, (reference) => {
    const digits = reference.replace(/^&#x?/i, "").replace(/;$/, "");
    return String.fromCodePoint(Number.parseInt(digits, /^&#x/i.test(reference) ? 16 : 10));
  });
  const scheme = decoded
    .replace(/[\s\p{Cc}]/gu, "")
    .split(":")[0]
    .toLowerCase();
  return unsafeSchemes.includes(scheme);
}

/**
 * Pastes `clipboard` (data by MIME type) the way a browser does: a `paste` event carrying the data is dispatched on the
 * editor, so ProseMirror runs every paste handler and inserts the clipboard content itself when none of them takes it.
 */
async function paste(editor: Editor, clipboard: Record<string, string>) {
  const clipboardData = new DataTransfer();
  for (const [type, data] of Object.entries(clipboard)) clipboardData.setData(type, data);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  await act(async () => {
    editor.view.dom.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
}

/** Every link mark in the editor's document, read as the destination it would navigate to. */
function linkedHrefs(editor: Editor) {
  const hrefs: string[] = [];
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "link") hrefs.push(String(mark.attrs.href));
  });
  return hrefs;
}

/** Every `href` the editor has rendered, whether it marks a link or not. */
const renderedHrefs = (element: Element) =>
  [...element.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href") ?? "");

/**
 * Every `href` and `src` the reader rendered, whether it came from a Markdown link or from an image. An emptied
 * attribute counts too: it is a destination that was refused rather than one that was dropped.
 */
function renderedUrls(element: Element) {
  return [...element.querySelectorAll("[href], [src]")].flatMap((node) =>
    ["href", "src"].map((attribute) => node.getAttribute(attribute)).filter((value): value is string => value !== null),
  );
}

/** Links documentation is allowed to keep, and the text they are written on. */
const allowedLinks: Array<[text: string, href: string]> = [
  ["docs", "https://example.com/docs"],
  ["legacy", "http://example.com/legacy"],
  ["mail", "mailto:team@example.com"],
  ["runbook", "./runbook.md"],
  ["top", "#rollback"],
  ["javascript.com", "https://javascript.com/"],
  ["javascript guide", "https://example.com/javascript:guide"],
];

describe("unsafe URL schemes in read-only documentation", () => {
  it("renders Markdown links and images with no javascript: or data: URL", () => {
    const payload = "PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";
    const value = [
      "[click me](javascript:alert(1))",
      `[report](data:text/html;base64,${payload})`,
      `[inline image](data:image/svg+xml;base64,${payload})`,
      `[newline](java&#9;script:alert(1))`,
      '<a href="data:text/html,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">raw anchor</a>',
    ].join("\n\n");
    const { container } = render(<MarkdownContent value={value} />);

    expect(renderedUrls(container).filter(isUnsafeUrl)).toEqual([]);
    // The words are still readable, so refusing the URL costs the reader no text.
    expect(container.textContent).toContain("click me");
    expect(container.textContent).toContain("report");
    expect(container.textContent).toContain("raw anchor");
  });

  it("escapes raw HTML instead of reading it as an anchor", () => {
    const { container } = render(
      <MarkdownContent value={'<a href="data:text/html,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">raw anchor</a>'} />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe('<a href="data:text/html,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">raw anchor</a>');
  });

  it("keeps the links documentation is allowed to have", () => {
    const value = allowedLinks.map(([text, href]) => `[${text}](${href})`).join("\n\n");
    const { container } = render(<MarkdownContent value={value} />);

    expect(renderedUrls(container)).toEqual(allowedLinks.map(([, href]) => href));
  });

  it("keeps an unsafe scheme in code and in escaped Markdown as text", () => {
    const value = [
      "Never write `[x](javascript:alert(1))` as a link.",
      "\\[not a link\\](javascript:alert(1))",
      "`data:text/html;base64,PHNjcmlwdD4=`",
      "",
      "```html",
      '<a href="javascript:alert(1)">click me</a>',
      "```",
    ].join("\n");
    const { container } = render(<MarkdownContent value={value} />);

    expect(renderedUrls(container)).toEqual([]);
    // A fenced block is rendered with the newline its closing fence leaves, so the code is read without it.
    const code = [...container.querySelectorAll("code")].map((node) => node.textContent?.trimEnd());
    expect(code).toContain("[x](javascript:alert(1))");
    expect(code).toContain("data:text/html;base64,PHNjcmlwdD4=");
    expect(code).toContain('<a href="javascript:alert(1)">click me</a>');
    expect(container.textContent).toContain("[not a link](javascript:alert(1))");
  });
});

describe("unsafe URL schemes pasted into the editor", () => {
  it("does not link Markdown pasted with a javascript: destination", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await paste(editor, { "text/plain": "Before [click me](javascript:alert(1)) after" });

    expect(linkedHrefs(editor)).toEqual([]);
    expect(renderedHrefs(element).filter(isUnsafeUrl)).toEqual([]);
    expect(editor.getMarkdown()).toBe("Before click me after");
  });

  const unsafeDestinations = [
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/hosts",
    // A character reference and a tab are both removed from a URL before a browser reads its scheme.
    "java&#9;script:alert(1)",
    "java&#58;script:alert(1)",
    "JAVASCRIPT:alert(1)",
  ];
  for (const destination of unsafeDestinations) {
    it(`does not link Markdown pasted with ${destination}`, async () => {
      const { editor, element } = renderDocumentationEditor("");
      await paste(editor, { "text/plain": `Read [this](${destination}) now` });

      expect(linkedHrefs(editor)).toEqual([]);
      expect(renderedHrefs(element).filter(isUnsafeUrl)).toEqual([]);
      expect(editor.getText()).toBe("Read this now");
    });
  }

  const pastedAnchors = [
    '<p><a href="javascript:alert(1)">click me</a></p>',
    '<p><a href="java&#9;script:alert(1)">click me</a></p>',
    '<p><a href="data:text/html,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click me</a></p>',
    '<p><a href="vbscript:msgbox(1)">click me</a></p>',
  ];
  for (const html of pastedAnchors) {
    it(`does not link pasted HTML ${html}`, async () => {
      const { editor, element } = renderDocumentationEditor("");
      await paste(editor, { "text/html": html, "text/plain": "click me" });

      expect(linkedHrefs(editor)).toEqual([]);
      expect(renderedHrefs(element).filter(isUnsafeUrl)).toEqual([]);
      expect(editor.getText()).toBe("click me");
    });
  }

  it("still links pasted HTML documentation is allowed to link", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await paste(editor, {
      "text/html": '<a href="https://example.com/runbook">runbook</a>',
      "text/plain": "runbook",
    });

    expect(linkedHrefs(editor)).toEqual(["https://example.com/runbook"]);
    expect(renderedHrefs(element)).toContain("https://example.com/runbook");
    expect(editor.getMarkdown()).toBe("[runbook](https://example.com/runbook)");
  });

  it("leaves no unsafe destination in the Markdown it saves", async () => {
    const { editor } = renderDocumentationEditor("");
    await paste(editor, {
      "text/plain": "# Rollback\n\n[click me](javascript:alert(1))\n\n![payload](data:text/html;base64,PHNjcmlwdD4=)",
    });

    const saved = editor.getMarkdown();
    expect(saved).not.toContain("javascript:");
    expect(saved).not.toContain("data:");
    expect(renderDocumentationEditor(saved).editor.getMarkdown()).toBe(saved);
  });
});

describe("documentation the URL allow-list keeps working", () => {
  it("links every Markdown link documentation is allowed to have", async () => {
    const { editor } = renderDocumentationEditor("");
    await paste(editor, { "text/plain": allowedLinks.map(([text, href]) => `[${text}](${href})`).join(" ") });

    expect(linkedHrefs(editor)).toEqual(allowedLinks.map(([, href]) => href));
    expect(editor.getMarkdown()).toBe(allowedLinks.map(([text, href]) => `[${text}](${href})`).join(" "));
  });

  const typed: Array<[text: string, href?: string]> = [
    ["https://example.com/docs ", "https://example.com/docs"],
    ["www.example.com ", "http://www.example.com"],
    ["ops@example.com ", "mailto:ops@example.com"],
    // A scheme on its own does not make a link, and `https://javascript.com/` and `https://example.com/javascript:guide`
    // only mention the word, in a hostname and in a path.
    ["javascript://example.com/x ", undefined],
    ["data://example.com/x ", undefined],
    ["vbscript://example.com/x ", undefined],
    ["file://example.com/notes.txt ", undefined],
    ["ftp://example.com/archive ", undefined],
    ["git://example.com/repo.git ", undefined],
    ["README.md and deploy.sh ", undefined],
  ];
  for (const [text, href] of typed) {
    it(`links ${href ? href : "nothing"} when ${JSON.stringify(text)} is typed`, async () => {
      const { editor } = renderDocumentationEditor("");
      await typeInEditor(editor, text);

      expect(linkedHrefs(editor)).toEqual(href ? [href] : []);
    });
  }

  it("keeps code blocks and inline code with an unsafe scheme as code, byte for byte", async () => {
    const code = [
      'const blocked = "javascript:alert(1)";',
      'const payload = "data:text/html;base64,PHNjcmlwdD4=";',
      "// [x](javascript:alert(1)) is text, not a link",
    ].join("\n");
    const markdown = [
      "Paste a payload, then open it:",
      "",
      "```html",
      code,
      "```",
      "",
      "Inline `javascript:alert(1)` stays code.",
    ].join("\n");
    const { editor } = renderDocumentationEditor("");
    await paste(editor, { "text/plain": markdown });

    const codeBlockText = (opened: Editor) => {
      const block: JSONContent | undefined = (opened.getJSON().content ?? []).find((node) => node.type === "codeBlock");
      return block?.content?.[0]?.text;
    };
    expect(codeBlockText(editor)).toBe(code);
    expect(linkedHrefs(editor)).toEqual([]);

    const saved = editor.getMarkdown();
    expect(saved).toBe(markdown);
    // Reopening the saved Markdown must bring the code back exactly as it was written.
    const reopened = renderDocumentationEditor(saved).editor;
    expect(codeBlockText(reopened)).toBe(code);
    expect(reopened.getMarkdown()).toBe(saved);
  });

  it("keeps escaped literals as text", async () => {
    const { editor } = renderDocumentationEditor("");
    await paste(editor, { "text/plain": "\\[not a link\\](javascript:alert(1)) and `javascript:alert(1)`" });

    expect(linkedHrefs(editor)).toEqual([]);
    expect(editor.getText()).toBe("[not a link](javascript:alert(1)) and javascript:alert(1)");
    expect(editor.getMarkdown()).toBe("\\[not a link\\](javascript:alert(1)) and `javascript:alert(1)`");
  });
});
