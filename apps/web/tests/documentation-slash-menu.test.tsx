import { describe, expect, it, onTestFinished } from "bun:test";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Editor, Extension, type JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Type } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "../src/components/ui";
import { documentationExtensions } from "../src/features/inspector/documentation/extensions";
import {
  filterSlashCommands,
  type SlashCommandItem,
  slashCommands,
} from "../src/features/inspector/documentation/slash-commands";
import { renderDocumentationEditor, typeInEditor } from "./support/editor";

const allTitles = [
  "Text",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Bulleted list",
  "Numbered list",
  "Task list",
  "Quote",
  "Code block",
  "Divider",
  "Table",
];

const paragraph = (text?: string): JSONContent =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
const heading = (level: number, text?: string): JSONContent => ({
  type: "heading",
  attrs: { level },
  ...(text ? { content: [{ type: "text", text }] } : {}),
});
const cell = (type: string): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  content: [paragraph()],
});
const row = (type: string): JSONContent => ({ type: "tableRow", content: [cell(type), cell(type), cell(type)] });
const table: JSONContent = { type: "table", content: [row("tableHeader"), row("tableCell"), row("tableCell")] };
const blocksOf = (editor: Editor): JSONContent[] => editor.getJSON().content ?? [];
const setup = () => userEvent.setup({ delay: null });

const menu = () => screen.getByRole("listbox", { name: "Insert block" });
const isMenuOpen = () => screen.queryByRole("listbox", { name: "Insert block" }) !== null;
const option = (name: string) => within(menu()).getByRole("option", { name });
const activeOption = () => within(menu()).getByRole("option", { selected: true });
// Elements are compared by id or identity, so that a failure prints a short message rather than a whole DOM tree.
const hasFocus = (element: Element) => document.activeElement === element;

/** Checks that the menu lists exactly `titles`, in order. */
function expectOptions(titles: string[]) {
  const list = menu();
  const listed = within(list)
    .queryAllByRole("option")
    .map(({ id }) => id);
  expect(listed).toEqual(titles.map((name) => within(list).getByRole("option", { name }).id));
}

/** Checks that `name` is the only active option and that the editor points assistive technology at it. */
function expectActive(element: HTMLElement, name: string) {
  const active = activeOption();
  expect(active.id).toBe(option(name).id);
  expect(element.getAttribute("aria-controls")).toBe(menu().id);
  expect(element.getAttribute("aria-activedescendant")).toBe(active.id);
}

function expectMenuClosed(element: HTMLElement) {
  expect(isMenuOpen()).toBe(false);
  expect(element.hasAttribute("aria-controls")).toBe(false);
  expect(element.hasAttribute("aria-activedescendant")).toBe(false);
}

/** Renders an editor whose caret is at the start of a paragraph of text, ready to type the slash before that text. */
function renderWithTextAfterCaret(markdown: string) {
  const rendered = renderDocumentationEditor(markdown);
  rendered.editor.commands.setTextSelection(1);
  return rendered;
}

/** Stands in for the editor component's Escape shortcut, which blurs the editor at a priority below the default. */
const EscapeToBlur = Extension.create({
  name: "escapeToBlur",
  priority: 50,
  addKeyboardShortcuts() {
    return {
      Escape: () => {
        (this.editor.view.dom as HTMLElement).blur();
        return true;
      },
    };
  },
});

/**
 * Renders the documentation editor with an Escape shortcut that blurs it. With `inModalDialog`, the editor is inside a
 * modal Radix dialog that stays open on Escape while an inline editor has focus, as the canvas details dialog does.
 */
function renderWithEscapeShortcut({ inModalDialog = false } = {}) {
  const rendered: { editor?: Editor } = {};
  function DocumentationEditor() {
    const [open, setOpen] = useState(true);
    const editor = useEditor({
      extensions: [...documentationExtensions(), EscapeToBlur],
      content: "",
      contentType: "markdown",
      editorProps: { attributes: { "data-inline-editing": "true" } },
    });
    rendered.editor = editor;
    if (!inModalDialog) return <EditorContent editor={editor} />;
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (document.activeElement?.hasAttribute("data-inline-editing")) event.preventDefault();
          }}
        >
          <DialogTitle>Component details</DialogTitle>
          <EditorContent editor={editor} />
        </DialogContent>
      </Dialog>
    );
  }
  render(<DocumentationEditor />);
  const { editor } = rendered;
  if (!editor) throw new Error("The documentation editor did not render.");
  onTestFinished(() => editor.destroy());
  return { editor, element: editor.view.dom as HTMLElement };
}

describe("filtering slash commands", () => {
  const cases: Array<[string, string, string[]]> = [
    ["an empty query", "", allTitles],
    ["a query of only spaces", "   ", allTitles],
    ["a title prefix in another case", "HEAD", ["Heading 1", "Heading 2", "Heading 3"]],
    ["a keyword", "h2", ["Heading 2"]],
    ["surrounding spaces", "  quote ", ["Quote"]],
    ["a word inside titles", "list", ["Bulleted list", "Numbered list", "Task list"]],
    ["a keyword for a divider", "rule", ["Divider"]],
    ["no match", "diagram", []],
  ];
  for (const [name, query, titles] of cases) {
    it(`matches ${name}`, () => {
      expect(filterSlashCommands(query).map((command) => command.title)).toEqual(titles);
    });
  }

  it("lists titles that start with the query first, and otherwise keeps the declared order", () => {
    const command = (title: string, keywords: string[] = []): SlashCommandItem => ({
      id: title.toLowerCase().replace(/\s+/g, "-"),
      title,
      description: `Inserts ${title}`,
      keywords,
      icon: Type,
      run: () => true,
    });
    const commands = [
      command("Callout", ["note"]),
      command("Banner"),
      command("Footnote"),
      command("Note"),
      command("Notes summary"),
    ];
    expect(filterSlashCommands("note", commands).map(({ title }) => title)).toEqual([
      "Note",
      "Notes summary",
      "Callout",
      "Footnote",
    ]);
    expect(filterSlashCommands("", commands)).toEqual(commands);
  });

  it("declares every command once with a description and keywords", () => {
    expect(slashCommands.map((command) => command.title)).toEqual(allTitles);
    expect(new Set(slashCommands.map((command) => command.id)).size).toBe(allTitles.length);
    for (const command of slashCommands) {
      expect(command.description).not.toBe("");
      expect(command.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe("slash commands", () => {
  const fromEmptyParagraph: Array<[string, JSONContent[]]> = [
    ["Text", [paragraph()]],
    ["Heading 1", [heading(1), paragraph()]],
    ["Heading 2", [heading(2), paragraph()]],
    ["Heading 3", [heading(3), paragraph()]],
    ["Bulleted list", [{ type: "bulletList", content: [{ type: "listItem", content: [paragraph()] }] }, paragraph()]],
    [
      "Numbered list",
      [
        {
          type: "orderedList",
          attrs: { start: 1, type: null },
          content: [{ type: "listItem", content: [paragraph()] }],
        },
        paragraph(),
      ],
    ],
    [
      "Task list",
      [
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph()] }] },
        paragraph(),
      ],
    ],
    ["Quote", [{ type: "blockquote", content: [paragraph()] }, paragraph()]],
    ["Code block", [{ type: "codeBlock", attrs: { language: null } }, paragraph()]],
    ["Divider", [{ type: "horizontalRule" }, paragraph()]],
    ["Table", [table, paragraph()]],
  ];
  for (const [title, blocks] of fromEmptyParagraph) {
    it(`turns an empty paragraph into ${title}`, async () => {
      const { editor, element } = renderDocumentationEditor("");
      await typeInEditor(element, "/");
      await setup().click(option(title));
      expect(blocksOf(editor)).toEqual(blocks);
      expectMenuClosed(element);
    });
  }

  const text = "Rollout plan";
  const fromParagraphWithText: Array<[string, JSONContent[]]> = [
    ["Text", [paragraph(text)]],
    ["Heading 1", [heading(1, text), paragraph()]],
    ["Heading 2", [heading(2, text), paragraph()]],
    ["Heading 3", [heading(3, text), paragraph()]],
    [
      "Bulleted list",
      [{ type: "bulletList", content: [{ type: "listItem", content: [paragraph(text)] }] }, paragraph()],
    ],
    [
      "Numbered list",
      [
        {
          type: "orderedList",
          attrs: { start: 1, type: null },
          content: [{ type: "listItem", content: [paragraph(text)] }],
        },
        paragraph(),
      ],
    ],
    [
      "Task list",
      [
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph(text)] }] },
        paragraph(),
      ],
    ],
    ["Quote", [{ type: "blockquote", content: [paragraph(text)] }, paragraph()]],
    ["Code block", [{ type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text }] }, paragraph()]],
    // A divider or table cannot hold the text, so it goes in before the paragraph, where the caret was.
    ["Divider", [{ type: "horizontalRule" }, paragraph(text)]],
    ["Table", [table, paragraph(text)]],
  ];
  for (const [title, blocks] of fromParagraphWithText) {
    it(`turns a paragraph with text into ${title} and removes the slash query`, async () => {
      const { editor, element } = renderWithTextAfterCaret(text);
      await typeInEditor(element, "/");
      await setup().click(option(title));
      expect(blocksOf(editor)).toEqual(blocks);
    });
  }

  it("turns a heading back into a paragraph", async () => {
    const { editor, element } = renderWithTextAfterCaret("## Rollout plan");
    await typeInEditor(element, "/text");
    await setup().keyboard("{Enter}");
    // The empty paragraph after the heading was added when it opened, to keep a line to type on.
    expect(blocksOf(editor)).toEqual([paragraph("Rollout plan"), paragraph()]);
  });

  const insideOwnType: Array<[string, string, number, JSONContent]> = [
    [
      "- Gateway",
      "/bullet",
      3,
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Gateway")] }] },
    ],
    ["> Gateway", "/quote", 2, { type: "blockquote", content: [paragraph("Gateway")] }],
  ];
  for (const [markdown, query, caret, block] of insideOwnType) {
    it(`keeps ${block.type} when its own command is chosen inside it`, async () => {
      const { editor, element } = renderDocumentationEditor(markdown);
      // The start of the text inside the list item or quote.
      editor.commands.setTextSelection(caret);
      await typeInEditor(element, query);
      await setup().keyboard("{Enter}");
      expect(blocksOf(editor)[0]).toEqual(block);
    });
  }

  it("keeps the caret in the new block so typing continues there", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await typeInEditor(element, "/h1");
    await setup().keyboard("{Enter}");
    await typeInEditor(element, "Overview");
    expect(blocksOf(editor)).toEqual([heading(1, "Overview"), paragraph()]);
  });

  it("puts the caret in the first header cell of a new table", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await typeInEditor(element, "/table");
    await setup().keyboard("{Enter}");
    await typeInEditor(element, "Service");
    expect(blocksOf(editor)[0].content?.[0].content?.[0]).toMatchObject({
      type: "tableHeader",
      content: [paragraph("Service")],
    });
  });
});

describe("slash menu", () => {
  it("opens at the start of a block with every command and points the editor at it", async () => {
    const { element } = renderDocumentationEditor("");
    await typeInEditor(element, "/");
    expectOptions(allTitles);
    const described = within(menu()).getByRole("option", { description: "Insert a 3 × 3 table with a header row" });
    expect(described.id).toBe(option("Table").id);
    expectActive(element, "Text");
    expect(hasFocus(element)).toBe(true);
  });

  it("opens after whitespace", async () => {
    const { element } = renderDocumentationEditor("Intro");
    await typeInEditor(element, " /");
    expectActive(element, "Text");
  });

  it("does not open in the middle of a word", async () => {
    const { element } = renderDocumentationEditor("");
    await typeInEditor(element, "a/");
    expectMenuClosed(element);
    await typeInEditor(element, "b");
    expectMenuClosed(element);
  });

  it("does not open inside a code block", async () => {
    const { editor, element } = renderDocumentationEditor("```\nconst retries = 3;\n```");
    editor.commands.setTextSelection(1);
    await typeInEditor(element, "/");
    expectMenuClosed(element);
    // The end of the code.
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize - 1);
    await typeInEditor(element, " /");
    expectMenuClosed(element);
    expect(blocksOf(editor)[0]).toEqual({
      type: "codeBlock",
      attrs: { language: null },
      content: [{ type: "text", text: "/const retries = 3; /" }],
    });
  });

  it("does not open inside inline code", async () => {
    const { editor, element } = renderDocumentationEditor("Run `npm build` today");
    // After "npm " inside the code span.
    editor.commands.setTextSelection(9);
    await typeInEditor(element, "/");
    expectMenuClosed(element);
    expect(editor.getMarkdown()).toBe("Run `npm /build` today");
  });

  it("does not open inside a table cell, which holds text only", async () => {
    const { editor, element } = renderDocumentationEditor("| Service | Notes |\n| --- | --- |\n| Gateway | x |");
    let notes = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "x") notes = pos;
    });
    editor.commands.setTextSelection({ from: notes, to: notes + 1 });
    await typeInEditor(element, "/");
    expectMenuClosed(element);
    expect(editor.getMarkdown()).toContain("| Gateway | /     |");
  });

  it("filters the commands as the query is typed and edited", async () => {
    const { element } = renderDocumentationEditor("");
    await typeInEditor(element, "/hea");
    expectOptions(["Heading 1", "Heading 2", "Heading 3"]);
    expectActive(element, "Heading 1");
    await setup().keyboard("{Backspace}{Backspace}{Backspace}");
    await typeInEditor(element, "h3");
    expectOptions(["Heading 3"]);
    expectActive(element, "Heading 3");
  });

  it("closes when the query contains a space", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await typeInEditor(element, "/hea");
    expect(isMenuOpen()).toBe(true);
    await typeInEditor(element, " ding");
    expectMenuClosed(element);
    expect(blocksOf(editor)).toEqual([paragraph("/hea ding")]);
  });

  it("moves the active option with the arrow keys and wraps around", async () => {
    const { element } = renderDocumentationEditor("");
    const user = setup();
    await typeInEditor(element, "/hea");
    await user.keyboard("{ArrowDown}");
    expectActive(element, "Heading 2");
    expect(option("Heading 1").getAttribute("aria-selected")).toBe("false");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expectActive(element, "Heading 1");
    await user.keyboard("{ArrowUp}");
    expectActive(element, "Heading 3");
  });

  it("starts again from the first match when the query changes", async () => {
    const { element } = renderDocumentationEditor("");
    await typeInEditor(element, "/");
    await setup().keyboard("{ArrowUp}");
    expectActive(element, "Table");
    await typeInEditor(element, "h");
    expect(activeOption().id).toBe(within(menu()).getAllByRole("option")[0].id);
  });

  it("runs the active command on Enter and keeps focus in the editor", async () => {
    const { editor, element } = renderDocumentationEditor("");
    const user = setup();
    await typeInEditor(element, "/hea");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(blocksOf(editor)).toEqual([heading(2), paragraph()]);
    expectMenuClosed(element);
    expect(hasFocus(element)).toBe(true);
  });

  it("activates an option on hover and runs it on click without moving focus", async () => {
    const { editor, element } = renderDocumentationEditor("");
    const user = setup();
    await typeInEditor(element, "/");
    await user.hover(option("Code block"));
    expectActive(element, "Code block");
    await user.click(option("Quote"));
    expect(blocksOf(editor)).toEqual([{ type: "blockquote", content: [paragraph()] }, paragraph()]);
    expect(hasFocus(element)).toBe(true);
    expectMenuClosed(element);
  });

  it("closes on Escape, keeps the typed text, and keeps focus in the editor", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await typeInEditor(element, "/hea");
    await setup().keyboard("{Escape}");
    expectMenuClosed(element);
    expect(hasFocus(element)).toBe(true);
    expect(blocksOf(editor)).toEqual([paragraph("/hea")]);
  });

  it("claims Escape before the editor's own lower-priority Escape shortcut", async () => {
    const { element } = renderWithEscapeShortcut();
    const user = setup();
    await typeInEditor(element, "/");
    await user.keyboard("{Escape}");
    expectMenuClosed(element);
    expect(hasFocus(element)).toBe(true);
    // With the menu closed, Escape reaches the editor's shortcut.
    await user.keyboard("{Escape}");
    expect(hasFocus(element)).toBe(false);
  });

  it("shows an empty state and leaves Enter to the editor when nothing matches", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await typeInEditor(element, "/zzz");
    expect(within(menu()).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("No matching blocks");
    expect(element.getAttribute("aria-controls")).toBe(menu().id);
    expect(element.hasAttribute("aria-activedescendant")).toBe(false);
    await setup().keyboard("{Enter}");
    expect(blocksOf(editor)).toEqual([paragraph("/zzz"), paragraph()]);
    expectMenuClosed(element);
    expect(screen.queryByText("No matching blocks")).toBeNull();
  });

  it("closes when focus leaves the editor", async () => {
    const { element } = renderDocumentationEditor("");
    const field = document.body.appendChild(document.createElement("input"));
    onTestFinished(() => field.remove());
    await typeInEditor(element, "/");
    await act(async () => field.focus());
    expectMenuClosed(element);
  });

  it("gives each editor's menu its own ids", async () => {
    const first = renderDocumentationEditor("");
    const second = renderDocumentationEditor("");
    await typeInEditor(first.element, "/");
    const firstIds = [menu().id, activeOption().id];
    await setup().keyboard("{Escape}");
    await typeInEditor(second.element, "/");
    expect(second.element.getAttribute("aria-controls")).toBe(menu().id);
    expect(firstIds).not.toContain(menu().id);
    expect(firstIds).not.toContain(activeOption().id);
  });
});

describe("slash menu placement", () => {
  it("mounts inside the editor's dialog and removes itself when it closes", async () => {
    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    const { element } = renderDocumentationEditor("", { container: dialog });
    const childCount = dialog.childElementCount;
    await typeInEditor(element, "/");
    expect(dialog.contains(menu())).toBe(true);
    expect(element.contains(menu())).toBe(false);
    await setup().keyboard("{Escape}");
    expectMenuClosed(element);
    expect(dialog.childElementCount).toBe(childCount);
  });

  it("falls back to the document body outside a dialog", async () => {
    const { element } = renderDocumentationEditor("");
    await typeInEditor(element, "/");
    const list = menu();
    expect(list.closest('[role="dialog"]')).toBeNull();
    const bodyChild = Array.from(document.body.children).find((child) => child.contains(list));
    expect(bodyChild?.contains(element)).toBe(false);
  });

  it("removes the menu when the editor is destroyed while it is open", async () => {
    const { editor, element } = renderDocumentationEditor("");
    await typeInEditor(element, "/");
    const mounted = Array.from(document.body.children).find((child) => child.contains(menu()));
    await act(async () => editor.destroy());
    expect(mounted?.isConnected).toBe(false);
    expect(element.hasAttribute("aria-controls")).toBe(false);
    expect(element.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("works inside a modal dialog: options are clickable and Escape closes only the menu", async () => {
    const { editor, element } = renderWithEscapeShortcut({ inModalDialog: true });
    const user = setup();
    const dialog = screen.getByRole("dialog", { name: "Component details" });

    await typeInEditor(element, "/");
    expect(dialog.contains(menu())).toBe(true);
    // The modal dialog blocks pointer events outside itself, so the menu must be inside it to be clickable.
    await user.click(option("Heading 2"));
    expect(blocksOf(editor)).toEqual([heading(2), paragraph()]);

    await typeInEditor(element, "/");
    await user.keyboard("{Escape}");
    expectMenuClosed(element);
    expect(hasFocus(element)).toBe(true);
    expect(dialog.isConnected).toBe(true);
  });
});
