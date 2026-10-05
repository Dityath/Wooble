import { describe, expect, it, spyOn } from "bun:test";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor, JSONContent } from "@tiptap/core";
import { fitToSchema } from "../src/features/inspector/documentation/markdown-fidelity";
import { renderDocumentationEditor, typeInEditor } from "./support/editor";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const blocksOf = (editor: Editor): JSONContent[] => editor.getJSON().content ?? [];

/** Opens Markdown in the editor and saves it, then reopens the saved Markdown, as reloading documentation does. */
function roundTrip(markdown: string) {
  const { editor } = renderDocumentationEditor(markdown);
  const saved = editor.getMarkdown();
  const reopened = renderDocumentationEditor(saved).editor;
  // Reopening saved documentation must neither change its Markdown nor lose content.
  expect(reopened.getMarkdown()).toBe(saved);
  expect(reopened.getJSON()).toEqual(editor.getJSON());
  return { blocks: blocksOf(editor), saved };
}

describe("documentation Markdown", () => {
  it("keeps paragraphs and headings of every level", () => {
    const markdown = [
      "# Payments",
      "## Context",
      "### Decision",
      "#### Options",
      "##### Notes",
      "###### Footnotes",
      "The API accepts checkout requests.",
    ].join("\n\n");
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks.map((node) => [node.type, node.attrs?.level])).toEqual([
      ["heading", 1],
      ["heading", 2],
      ["heading", 3],
      ["heading", 4],
      ["heading", 5],
      ["heading", 6],
      ["paragraph", undefined],
    ]);
    expect(saved).toBe(markdown);
  });

  it("keeps bold, italic, strikethrough, inline code, and links", () => {
    const markdown =
      "Use **bold**, *italic*, ~~struck~~, `inline code`, and [the runbook](https://example.com/runbook).";
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks[0].content).toMatchObject([
      { text: "Use " },
      { text: "bold", marks: [{ type: "bold" }] },
      { text: ", " },
      { text: "italic", marks: [{ type: "italic" }] },
      { text: ", " },
      { text: "struck", marks: [{ type: "strike" }] },
      { text: ", " },
      { text: "inline code", marks: [{ type: "code" }] },
      { text: ", and " },
      { text: "the runbook", marks: [{ type: "link", attrs: { href: "https://example.com/runbook" } }] },
      { text: "." },
    ]);
    expect(saved).toBe(markdown);
  });

  it("keeps bulleted lists with nested items", () => {
    const markdown = "- Gateway\n- Services\n  - Billing\n  - Ledger";
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks).toMatchObject([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph("Gateway")] },
          {
            type: "listItem",
            content: [
              paragraph("Services"),
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [paragraph("Billing")] },
                  { type: "listItem", content: [paragraph("Ledger")] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(saved).toBe(markdown);
  });

  it("keeps numbered lists", () => {
    const markdown = "1. Provision the database\n2. Deploy the service\n   - Canary first";
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks).toMatchObject([
      {
        type: "orderedList",
        attrs: { start: 1 },
        content: [
          { type: "listItem", content: [paragraph("Provision the database")] },
          {
            type: "listItem",
            content: [
              paragraph("Deploy the service"),
              { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Canary first")] }] },
            ],
          },
        ],
      },
    ]);
    expect(saved).toBe(markdown);
  });

  it("keeps checked, unchecked, and nested task items", () => {
    const markdown =
      "- [ ] Draft the ADR\n- [x] Review with the platform team\n  - [x] Security sign-off\n  - [ ] Capacity plan";
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks).toMatchObject([
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [paragraph("Draft the ADR")] },
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              paragraph("Review with the platform team"),
              {
                type: "taskList",
                content: [
                  { type: "taskItem", attrs: { checked: true }, content: [paragraph("Security sign-off")] },
                  { type: "taskItem", attrs: { checked: false }, content: [paragraph("Capacity plan")] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(saved).toBe(markdown);
  });

  it("keeps blockquotes with several paragraphs", () => {
    const markdown = "> Card numbers never leave the vault.\n>\n> Tokens are scoped to one merchant.";
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks).toMatchObject([
      {
        type: "blockquote",
        content: [paragraph("Card numbers never leave the vault."), paragraph("Tokens are scoped to one merchant.")],
      },
    ]);
    expect(saved).toBe(markdown);
  });

  it("keeps fenced code blocks and their language", () => {
    const markdown = "```ts\nexport const retries = 3;\nexport const timeout_ms = 2000;\n```\n\n```\nGET /health\n```";
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks).toMatchObject([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "export const retries = 3;\nexport const timeout_ms = 2000;" }],
      },
      { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "GET /health" }] },
    ]);
    expect(saved).toBe(markdown);
  });

  it("keeps dividers", () => {
    const markdown = "Above the line\n\n---\n\nBelow the line";
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks.map((node) => node.type)).toEqual(["paragraph", "horizontalRule", "paragraph"]);
    expect(saved).toBe(markdown);
  });

  it("keeps tables with a header row", () => {
    const table = "| Service | Owner    |\n| ------- | -------- |\n| Gateway | Platform |\n| Ledger  | Payments |";
    const { blocks, saved } = roundTrip(table);
    const row = (cellType: string, cells: string[]) => ({
      type: "tableRow",
      content: cells.map((text) => ({ type: cellType, content: [paragraph(text)] })),
    });
    expect(blocks).toMatchObject([
      {
        type: "table",
        content: [
          row("tableHeader", ["Service", "Owner"]),
          row("tableCell", ["Gateway", "Platform"]),
          row("tableCell", ["Ledger", "Payments"]),
        ],
      },
    ]);
    // Columns are padded to one width, and the table is written with a blank line around it.
    expect(saved).toBe(`\n${table}\n`);
  });

  it("saves an empty document as empty Markdown", () => {
    const { blocks, saved } = roundTrip("");
    expect(blocks).toEqual([{ type: "paragraph" }]);
    expect(saved).toBe("");
  });

  it("round-trips architecture documentation without loss", () => {
    const dependencies = [
      "| Service | Protocol | Owner |",
      "| ------- | -------- | ----- |",
      "| Ledger  | gRPC     | Core  |",
      "| Fraud   | REST     | Risk  |",
    ].join("\n");
    const markdown = [
      "# Payments API",
      "Accepts checkout requests and records **ledger entries** for each capture.",
      "## Responsibilities",
      "- Validate checkout requests\n- Publish `payment.captured` events\n  - Consumed by the ledger service",
      "## Dependencies",
      // Tables are written with a blank line around them.
      `\n${dependencies}\n`,
      "## Deployment",
      "1. Build the container image\n2. Run the database migrations",
      "```yaml\nreplicas: 3\nstrategy: rolling\n```",
      "> Card numbers never leave the tokenization service.",
      "---",
      "### Open questions",
      "- [x] Choose the idempotency key format\n- [ ] Decide on the ~~v1~~ *v2* webhook schema",
      "See the [runbook](https://example.com/runbooks/payments) for incident steps.",
    ].join("\n\n");
    const { blocks, saved } = roundTrip(markdown);
    expect(blocks.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "bulletList",
      "heading",
      "table",
      "heading",
      "orderedList",
      "codeBlock",
      "blockquote",
      "horizontalRule",
      "heading",
      "taskList",
      "paragraph",
    ]);
    expect(saved).toBe(markdown);
  });

  const equivalentSyntax: Array<[string, string, string]> = [
    ["asterisk bullets", "* Gateway\n* Ledger", "- Gateway\n- Ledger"],
    ["underscore emphasis", "__Bold__ and _italic_", "**Bold** and *italic*"],
    ["setext headings", "Overview\n========", "# Overview"],
    ["tilde fences", "~~~yaml\nreplicas: 2\n~~~", "```yaml\nreplicas: 2\n```"],
    ["indented code", "    GET /health", "```\nGET /health\n```"],
    ["uppercase task marks", "- [X] Done", "- [x] Done"],
    ["asterisk dividers", "***", "---"],
    ["literal Markdown characters", "The user_id column", "The user\\_id column"],
  ];
  for (const [name, input, canonical] of equivalentSyntax) {
    it(`writes ${name} in one canonical form`, () => {
      expect(roundTrip(input).saved).toBe(canonical);
    });
  }

  /** Saves `content`, then reopens the saved Markdown, which must give back the same blocks. */
  function roundTripBlocks(content: JSONContent[]) {
    const { editor } = renderDocumentationEditor("");
    editor.commands.setContent({ type: "doc", content });
    const saved = editor.getMarkdown();
    expect(blocksOf(renderDocumentationEditor(saved).editor)).toEqual(blocksOf(editor));
    return saved;
  }

  it("keeps paragraph text that looks like the start of another block", () => {
    const lookalikes = ["# Not a heading", "- Not a bullet", "+ Not a bullet", "1. Not a list", "2) Not a list", "---"];
    const saved = roundTripBlocks(lookalikes.map(paragraph));
    expect(saved).toBe(
      "\\# Not a heading\n\n\\- Not a bullet\n\n\\+ Not a bullet\n\n1\\. Not a list\n\n2\\) Not a list\n\n\\---",
    );
  });

  it("keeps lookalike block syntax after a line break and inside list items", () => {
    const breakThen = (first: string, second: string) => ({
      type: "paragraph",
      content: [{ type: "text", text: first }, { type: "hardBreak" }, { type: "text", text: second }],
    });
    const saved = roundTripBlocks([
      breakThen("Release title", "==="),
      breakThen("Steps", "## Not a heading"),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("2026. A planning year")] }] },
    ]);
    // The trailing empty paragraph after the list keeps a line to type on.
    expect(saved).toBe("Release title  \n\\===\n\nSteps  \n\\## Not a heading\n\n- 2026\\. A planning year\n\n");
  });

  it("drops leading spaces instead of turning a paragraph into indented code", () => {
    const { editor } = renderDocumentationEditor("");
    editor.commands.setContent({ type: "doc", content: [paragraph("    Indented note")] });
    expect(editor.getMarkdown()).toBe("Indented note");
  });

  it("keeps code that contains a Markdown fence inside its block", () => {
    const sample = "Install it:\n\n```sh\nbun add wooble\n```";
    const saved = roundTripBlocks([
      { type: "codeBlock", attrs: { language: "md" }, content: [{ type: "text", text: sample }] },
    ]);
    // The trailing empty paragraph after the block keeps a line to type on.
    expect(saved).toBe(`\`\`\`\`md\n${sample}\n\`\`\`\`\n\n`);
  });

  it("reopens an empty numbered item as an editable item", () => {
    const { editor } = renderDocumentationEditor("1. Provision the database\n2. ");
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(blocksOf(editor)).toMatchObject([
      {
        type: "orderedList",
        content: [
          { type: "listItem", content: [paragraph("Provision the database")] },
          { type: "listItem", content: [{ type: "paragraph" }] },
        ],
      },
    ]);
  });

  // Images and raw HTML are not supported yet. These tests record what editing such a document keeps.
  it("keeps only the alt text of an image", () => {
    const { editor } = renderDocumentationEditor(
      "Before\n\n![Architecture diagram](diagram.png)\n\nSee ![the logo](logo.svg) here",
    );
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(blocksOf(editor)).toEqual([
      paragraph("Before"),
      paragraph("Architecture diagram"),
      paragraph("See the logo here"),
    ]);
    expect(editor.getMarkdown()).toBe("Before\n\nArchitecture diagram\n\nSee the logo here");
  });

  it("keeps the text of raw HTML but not its tags or comments", () => {
    const { editor } = renderDocumentationEditor(
      "Intro\n\n<details>\n<summary>Rollback</summary>\n\nRestore the snapshot.\n\n</details>\n\nPress <kbd>Ctrl</kbd> now\n\n<!-- reviewer note -->\n\nOutro",
    );
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.getMarkdown()).toBe("Intro\n\nRollback\n\nRestore the snapshot.\n\n\n\nPress Ctrl now\n\n\n\nOutro");
  });

  it("saves blocks created with Markdown shortcuts", async () => {
    const { editor, element } = renderDocumentationEditor("");
    const user = userEvent.setup({ delay: null });
    await typeInEditor(element, "## Rollout");
    await user.keyboard("{Enter}");
    await typeInEditor(element, "[ ] Enable the *billing* flag");
    // A trailing empty paragraph keeps a line to type after the list, so the Markdown ends with a blank line.
    expect(editor.getMarkdown()).toBe("## Rollout\n\n- [ ] Enable the *billing* flag\n\n");
  });

  it("has no underline, because Markdown cannot store it", () => {
    const { editor } = renderDocumentationEditor("Rotate <u>every</u> key");
    expect(editor.schema.marks.underline).toBeUndefined();
    expect(editor.getMarkdown()).toBe("Rotate every key");
  });
});

describe("fitting parsed Markdown to the editor schema", () => {
  it("wraps a block that only fits inside another, such as a paragraph directly in a list", () => {
    const { editor } = renderDocumentationEditor("");
    const fitted = fitToSchema(
      { type: "doc", content: [{ type: "bulletList", content: [paragraph("Gateway")] }] },
      editor.schema,
    );
    expect(fitted.content).toMatchObject([
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Gateway")] }] },
    ]);
    expect(() => editor.schema.nodeFromJSON(fitted).check()).not.toThrow();
  });

  it("leaves content with unknown node types for TipTap to report", () => {
    const { editor } = renderDocumentationEditor("");
    const unknown = { type: "doc", content: [{ type: "mermaidDiagram" }] };
    expect(fitToSchema(unknown, editor.schema)).toBe(unknown);
  });
});

describe("documentation editor", () => {
  it("shows the placeholder only while the document is empty", () => {
    const placeholder = "Describe this component";
    const empty = renderDocumentationEditor("", { placeholder });
    expect(empty.element.querySelector(`p[data-placeholder="${placeholder}"]`)).not.toBeNull();

    const filled = renderDocumentationEditor("Intro", { placeholder });
    filled.editor.commands.setTextSelection(filled.editor.state.doc.content.size);
    filled.editor.commands.enter();
    expect(blocksOf(filled.editor)).toEqual([paragraph("Intro"), { type: "paragraph" }]);
    expect(filled.element.querySelector(`[data-placeholder="${placeholder}"]`)).toBeNull();
  });

  it("places the caret instead of opening a link on a plain click", () => {
    const open = spyOn(window, "open").mockImplementation(() => null);
    try {
      const { editor, element } = renderDocumentationEditor("Read the [runbook](https://example.com/runbook).");
      const link = within(element).getByRole("link", { name: "runbook" });
      // happy-dom has no layout to turn click coordinates into a position, so pass the click to the editor's handlers.
      // The event is not dispatched: happy-dom would follow the link and fetch the page.
      const click = new MouseEvent("click", { button: 0 });
      Object.defineProperty(click, "target", { value: link });
      const handled = editor.view.someProp("handleClick", (handle) =>
        handle(editor.view, editor.view.posAtDOM(link, 0), click),
      );
      expect(handled).toBeFalsy();
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});
