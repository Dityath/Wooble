import { describe, expect, it } from "bun:test";
import { act } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { looksLikeMarkdown } from "../src/features/inspector/documentation/markdown-paste";
import { renderDocumentationEditor } from "./support/editor";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const blocksOf = (editor: Editor): JSONContent[] => editor.getJSON().content ?? [];

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
  // The editor inserted the content itself instead of leaving the paste to the browser.
  expect(event.defaultPrevented).toBe(true);
}

/** Returns the document range of the first occurrence of `text`, to place the caret or select text. */
function rangeOf(editor: Editor, text: string) {
  let range: { from: number; to: number } | undefined;
  editor.state.doc.descendants((node, pos) => {
    const index = node.isText && !range ? (node.text ?? "").indexOf(text) : -1;
    if (index >= 0) range = { from: pos + index, to: pos + index + text.length };
  });
  if (!range) throw new Error(`"${text}" is not in the document.`);
  return range;
}

// VS Code puts its language mode next to syntax-highlighted HTML on the clipboard.
const vscodeData = (mode: string) =>
  JSON.stringify({ version: 1, isFromEmptySelection: false, multicursorText: null, mode });
const highlighted = (lines: string[]) =>
  `<meta charset="utf-8"><div style="color: #cccccc; white-space: pre;">${lines
    .map((line) => `<div><span style="color: #569cd6;">${line}</span></div>`)
    .join("")}</div>`;

describe("recognizing pasted Markdown", () => {
  it("recognizes block syntax on any line", () => {
    const samples = {
      "ATX heading": "# Payments API",
      "level 6 heading": "Context first\n###### Footnotes",
      "dash bullet": "- Validate checkout requests",
      "asterisk bullet": "* Gateway\n* Ledger",
      "plus bullet": "+ Ledger",
      "nested bullet": "Services\n  - Billing",
      "numbered item": "1. Provision the database",
      "parenthesis numbered item": "2) Deploy the service",
      "unchecked task": "- [ ] Draft the ADR",
      "checked task": "- [x] Review with the platform team",
      quote: "> Card numbers never leave the vault.",
      "nested quote": "> > Tokens are scoped to one merchant.",
      "backtick fence": "```ts\nexport const retries = 3;\n```",
      "tilde fence": "~~~\nGET /health\n~~~",
      "dash break": "Above\n---\nBelow",
      "asterisk break": "***",
      "underscore break": "___",
      "spaced break": "- - -",
      "pipe table": "| Service | Owner |\n| --- | --- |\n| Gateway | Platform |",
      "aligned table": "| Service | Owner |\n| :------ | ----: |",
      "table without outer pipes": "Service | Owner\n--- | ---",
      "single-column table": "| Service |\n| --- |",
      "Windows line endings": "Intro\r\n- Gateway\r\n- Ledger",
    };
    const missed = Object.entries(samples).filter(([, text]) => !looksLikeMarkdown(text));
    expect(missed.map(([name]) => name)).toEqual([]);
  });

  it("recognizes unambiguous inline syntax", () => {
    const samples = {
      "asterisk bold": "Use **bold** for warnings",
      "underscore bold": "Use __bold__ for warnings",
      "inline code": "Run `bun test` before pushing",
      link: "See [the runbook](https://example.com/runbook) first",
      "link with a title": 'See [the runbook](https://example.com/runbook "Runbook") first',
      strikethrough: "The ~~v1~~ schema is retired",
    };
    const missed = Object.entries(samples).filter(([, text]) => !looksLikeMarkdown(text));
    expect(missed.map(([name]) => name)).toEqual([]);
  });

  it("does not mistake plain prose for Markdown", () => {
    const samples = {
      "single sentence": "The gateway forwards checkout requests to the ledger.",
      paragraphs: "Retries back off exponentially.\n\nTimeouts are logged.",
      empty: "",
      multiplication: "2 * 3 * 4",
      "spaced exponent": "2 ** 3 ** 4",
      "snake case": "snake_case_name",
      "intraword double underscores": "Rename snake__case__name later",
      "single emphasis": "Handle *every* retry and _each_ timeout",
      "bare URL": "https://example.com/docs/getting-started",
      "URL with underscores": "https://example.com/wiki/Payment_service_(v2)",
      "dash mid-line": "Prices - as of today - are fixed.",
      "hyphenated words": "Use the well-known pre-commit hook.",
      "line starting with a negative number": "-1 means no limit",
      "decimal number": "1.5 million requests per day",
      year: "In 2026 the ledger moved regions.",
      "email address": "Contact ops@example.com for access.",
      "C# and F#": "We write C# and F# services.",
      hashtag: "#launch-day",
      "ranking number": "#1 priority",
      "comparison mid-line": "Alert when latency > 300 ms",
      "comparison at line start": ">5 retries count as an outage",
      "two dashes": "--",
      "pipe without a separator row": "Gateway | Ledger",
      "separator row without a header": "Notes\n\n--- | ---",
      "mismatched table columns": "Service | Owner\n--- | --- | ---",
      "backticks as apostrophes": "It`s ready, isn`t it?",
      "brackets without a link": "See [1] and (2)",
      "Windows path": "C:\\Users\\example\\notes.txt",
    };
    const flagged = Object.entries(samples).filter(([, text]) => looksLikeMarkdown(text));
    expect(flagged.map(([name]) => name)).toEqual([]);
  });
});

describe("pasting Markdown into documentation", () => {
  const blockSamples: Array<{ name: string; markdown: string; blocks: JSONContent[]; saved: string }> = [
    {
      name: "a heading",
      markdown: "## Rollout plan",
      blocks: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Rollout plan" }] }],
      saved: "## Rollout plan\n\n",
    },
    {
      name: "a bulleted list",
      markdown: "- Gateway\n- Services\n  - Billing",
      blocks: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph("Gateway")] },
            {
              type: "listItem",
              content: [
                paragraph("Services"),
                { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Billing")] }] },
              ],
            },
          ],
        },
      ],
      saved: "- Gateway\n- Services\n  - Billing\n\n",
    },
    {
      name: "a numbered list with inline formatting",
      markdown: "1. Build the **container** image\n2. Run the migrations",
      blocks: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Build the " },
                    { type: "text", text: "container", marks: [{ type: "bold" }] },
                    { type: "text", text: " image" },
                  ],
                },
              ],
            },
            { type: "listItem", content: [paragraph("Run the migrations")] },
          ],
        },
      ],
      saved: "1. Build the **container** image\n2. Run the migrations\n\n",
    },
    {
      name: "a task list",
      markdown: "- [ ] Draft the ADR\n- [x] Review with the platform team",
      blocks: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [paragraph("Draft the ADR")] },
            { type: "taskItem", attrs: { checked: true }, content: [paragraph("Review with the platform team")] },
          ],
        },
      ],
      saved: "- [ ] Draft the ADR\n- [x] Review with the platform team\n\n",
    },
    {
      name: "a table",
      markdown: "| Service | Owner |\n| --- | --- |\n| Gateway | Platform |",
      blocks: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [paragraph("Service")] },
                { type: "tableHeader", content: [paragraph("Owner")] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [paragraph("Gateway")] },
                { type: "tableCell", content: [paragraph("Platform")] },
              ],
            },
          ],
        },
      ],
      saved: "\n| Service | Owner    |\n| ------- | -------- |\n| Gateway | Platform |\n\n\n",
    },
  ];
  for (const { name, markdown, blocks, saved } of blockSamples) {
    it(`turns ${name} into blocks`, async () => {
      const { editor } = renderDocumentationEditor("");
      await paste(editor, { "text/plain": markdown });
      // The editor keeps an empty paragraph after the pasted blocks to type on.
      expect(blocksOf(editor)).toMatchObject([...blocks, { type: "paragraph" }]);
      expect(blocksOf(editor)).toHaveLength(blocks.length + 1);
      expect(editor.getMarkdown()).toBe(saved);
    });
  }

  it("inserts blocks at the caret and keeps the text around them", async () => {
    const { editor } = renderDocumentationEditor("Intro\n\nBefore after");
    editor.commands.setTextSelection(rangeOf(editor, "after").from);
    await paste(editor, { "text/plain": "## Rollout\n\n- Gateway\n- Ledger" });
    expect(editor.getMarkdown()).toBe("Intro\n\nBefore \n\n## Rollout\n\n- Gateway\n- Ledger\n\nafter");
  });

  it("inserts inline Markdown into the sentence at the caret", async () => {
    const { editor } = renderDocumentationEditor("Before after");
    editor.commands.setTextSelection(rangeOf(editor, "after").from);
    await paste(editor, { "text/plain": "run `bun test` and read [the runbook](https://example.com/runbook) " });
    expect(blocksOf(editor)).toMatchObject([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Before run " },
          { type: "text", text: "bun test", marks: [{ type: "code" }] },
          { type: "text", text: " and read " },
          {
            type: "text",
            text: "the runbook",
            marks: [{ type: "link", attrs: { href: "https://example.com/runbook" } }],
          },
          { type: "text", text: " after" },
        ],
      },
    ]);
    expect(editor.getMarkdown()).toBe(
      "Before run `bun test` and read [the runbook](https://example.com/runbook) after",
    );
  });

  it("replaces the selected text with inline Markdown", async () => {
    const { editor } = renderDocumentationEditor("Read this guide");
    editor.commands.setTextSelection(rangeOf(editor, "this"));
    await paste(editor, { "text/plain": "**the** [deployment](https://example.com/deploy)" });
    expect(editor.getMarkdown()).toBe("Read **the** [deployment](https://example.com/deploy) guide");
  });

  it("replaces a selected paragraph with pasted blocks", async () => {
    const { editor } = renderDocumentationEditor("Intro\n\nOld summary\n\nOutro");
    editor.commands.setTextSelection(rangeOf(editor, "Old summary"));
    await paste(editor, { "text/plain": "## Summary\n\n- Gateway\n- Ledger" });
    expect(blocksOf(editor).map((node) => node.type)).toEqual(["paragraph", "heading", "bulletList", "paragraph"]);
    expect(editor.getMarkdown()).toBe("Intro\n\n## Summary\n\n- Gateway\n- Ledger\n\nOutro");
  });

  it("undoes a Markdown paste in one step", async () => {
    const { editor } = renderDocumentationEditor("Intro\n\nOld **summary** text\n\nOutro");
    const before = { json: editor.getJSON(), markdown: editor.getMarkdown() };
    editor.commands.setTextSelection({ from: rangeOf(editor, "Old").from, to: rangeOf(editor, " text").to });
    await paste(editor, { "text/plain": "## Summary\n\n- [ ] Gateway\n- [x] Ledger" });
    expect(editor.getMarkdown()).toBe("Intro\n\n## Summary\n\n- [ ] Gateway\n- [x] Ledger\n\nOutro");

    await act(async () => {
      editor.commands.undo();
    });
    expect(editor.getJSON()).toEqual(before.json);
    expect(editor.getMarkdown()).toBe(before.markdown);
  });

  it("pastes prose as plain text without reading it as Markdown", async () => {
    const { editor } = renderDocumentationEditor("");
    const lines = [
      "The gateway - our edge service - takes 1.5 million requests a day.",
      "Its retry_backoff_ms key is set in C# &amp; owned by #platform-ops.",
    ];
    await paste(editor, { "text/plain": lines.join("\n") });
    // Read as Markdown, the lines would join into one paragraph and &amp; would become &.
    expect(blocksOf(editor)).toEqual(lines.map(paragraph));
  });

  it("keeps asterisks and underscores in pasted prose literal, but links URLs", async () => {
    const { editor } = renderDocumentationEditor("");
    const lines = ["Capacity is 2 * 3 * 4 nodes per _zone_ and *region*.", "See https://example.com/capacity first."];
    await paste(editor, { "text/plain": lines.join("\n") });
    expect(blocksOf(editor)).toMatchObject([
      paragraph(lines[0]),
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See " },
          { type: "text", text: "https://example.com/capacity", marks: [{ type: "link" }] },
          { type: "text", text: " first." },
        ],
      },
    ]);
    expect(editor.getMarkdown()).toBe(
      "Capacity is 2 \\* 3 \\* 4 nodes per \\_zone\\_ and \\*region\\*.\n\nSee [https://example.com/capacity](https://example.com/capacity) first.",
    );
  });

  it("leaves a URL pasted over selected text to the link extension", async () => {
    const { editor } = renderDocumentationEditor("Read the runbook first");
    editor.commands.setTextSelection(rangeOf(editor, "runbook"));
    await paste(editor, { "text/plain": "https://example.com/runbook" });
    expect(editor.getMarkdown()).toBe("Read the [runbook](https://example.com/runbook) first");
  });

  it("uses the HTML of a rich-text paste instead of reading its plain text as Markdown", async () => {
    const { editor } = renderDocumentationEditor("");
    await paste(editor, {
      "text/html": "<p>Release <strong>notes</strong> for <em>v2</em></p>",
      "text/plain": "# Release **notes** for *v2*",
    });
    expect(blocksOf(editor)).toMatchObject([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Release " },
          { type: "text", text: "notes", marks: [{ type: "bold" }] },
          { type: "text", text: " for " },
          { type: "text", text: "v2", marks: [{ type: "italic" }] },
        ],
      },
    ]);
    expect(editor.getMarkdown()).toBe("Release **notes** for *v2*");
  });

  const vscodeSources = {
    "a Markdown file": vscodeData("markdown"),
    "a plain-text file": vscodeData("plaintext"),
    "an editor that names no language": JSON.stringify({ version: 1 }),
    "an editor whose data cannot be read": "{",
  };
  for (const [source, editorData] of Object.entries(vscodeSources)) {
    it(`reads Markdown copied from VS Code (${source}) from its plain text, not its highlighted HTML`, async () => {
      const { editor } = renderDocumentationEditor("");
      await paste(editor, {
        "text/html": highlighted(["## Rollout", "", "- [ ] Enable the billing flag"]),
        "text/plain": "## Rollout\n\n- [ ] Enable the billing flag",
        "vscode-editor-data": editorData,
      });
      expect(blocksOf(editor)).toMatchObject([
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Rollout" }] },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("Enable the billing flag")] }],
        },
        { type: "paragraph" },
      ]);
      expect(editor.getMarkdown()).toBe("## Rollout\n\n- [ ] Enable the billing flag\n\n");
    });
  }

  it("leaves code copied from VS Code in another language to the code block paste", async () => {
    const { editor } = renderDocumentationEditor("");
    // Read as Markdown, `Retry` would be inline code and the last line a bullet.
    const code = "const label = `Retry`;\nconst remaining = attempts\n  - 1;";
    await paste(editor, {
      "text/html": highlighted(code.split("\n")),
      "text/plain": code,
      "vscode-editor-data": vscodeData("typescript"),
    });
    expect(blocksOf(editor)[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [{ type: "text", text: code }],
    });
  });

  it("pastes Markdown into a code block literally", async () => {
    const { editor } = renderDocumentationEditor("```yaml\nreplicas: 3\n```");
    editor.commands.setTextSelection(rangeOf(editor, "replicas: 3").to);
    await paste(editor, { "text/plain": "\n# Not a heading\n- **not a list**" });
    expect(blocksOf(editor)).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "yaml" },
        content: [{ type: "text", text: "replicas: 3\n# Not a heading\n- **not a list**" }],
      },
      { type: "paragraph" },
    ]);
  });

  describe("in a table", () => {
    const table = "| Service | Owner |\n| --- | --- |\n| Gateway | Platform |\n| Ledger | Payments |";
    const cellTexts = (editor: Editor) => {
      const texts: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell")
          texts.push(node.textContent);
      });
      return texts;
    };
    // The Owner cell of the Gateway row.
    const platformCell = (editor: Editor) => blocksOf(editor)[0]?.content?.[1]?.content?.[1];

    it("formats inline Markdown pasted into a cell", async () => {
      const { editor } = renderDocumentationEditor(table);
      editor.commands.setTextSelection(rangeOf(editor, "Platform").to);
      await paste(editor, { "text/plain": " and [Risk](https://example.com/risk)" });
      expect(platformCell(editor)?.content).toMatchObject([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Platform and " },
            { type: "text", text: "Risk", marks: [{ type: "link", attrs: { href: "https://example.com/risk" } }] },
          ],
        },
      ]);
    });

    it("keeps block Markdown pasted into a cell as text, because a Markdown table cell holds only inline content", async () => {
      const { editor } = renderDocumentationEditor(table);
      editor.commands.setTextSelection(rangeOf(editor, "Platform").to);
      await paste(editor, { "text/plain": "- Risk\n- Fraud" });
      expect(platformCell(editor)?.content).toEqual([paragraph("Platform- Risk"), paragraph("- Fraud")]);
      // Saved, the cell's lines are joined by <br>, and reopen as lines of text in the cell.
      const saved = editor.getMarkdown();
      expect(saved).toContain("| Gateway | Platform- Risk<br>- Fraud |");
      const reopened = renderDocumentationEditor(saved).editor;
      expect(platformCell(reopened)?.content).toEqual([
        {
          type: "paragraph",
          content: [{ type: "text", text: "Platform- Risk" }, { type: "hardBreak" }, { type: "text", text: "- Fraud" }],
        },
      ]);
    });

    it("leaves a paste over selected cells to the table", async () => {
      const { editor } = renderDocumentationEditor(table);
      const cellBefore = (text: string) => editor.state.doc.resolve(rangeOf(editor, text).from).before(-1);
      await act(async () => {
        editor.view.dispatch(
          editor.state.tr.setSelection(
            CellSelection.create(editor.state.doc, cellBefore("Platform"), cellBefore("Payments")),
          ),
        );
      });
      await paste(editor, { "text/plain": "**Core**" });
      // The table pastes the text into every selected cell.
      expect(cellTexts(editor)).toEqual(["Service", "Owner", "Gateway", "**Core**", "Ledger", "**Core**"]);
    });
  });
});
