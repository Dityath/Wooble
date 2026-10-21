import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { copyMarkdown, documentationFileName } from "../src/features/inspector/documentation/export";
import { DocumentationExportActions } from "../src/features/inspector/documentation/export-actions";
import { RichDocumentation } from "../src/features/inspector/rich-documentation-editor";
import { FakeApi } from "./support/fake-api";
import { entity, ids, user, workspace } from "./support/fixtures";
import { renderRoute, renderWithQuery } from "./support/render";

const markdown =
  "---\ntitle: Example\n---\n\n![Diagram](diagram.png)\n\nNote[^1]\n\n[^1]: Footnote\n\n<div>Raw HTML</div>\n";
afterEach(() => mock.restore());

describe("documentation filenames", () => {
  it.each([
    ["Orders API", "Orders-API.md"],
    ['a<>:"/\\|?* b', "a-b.md"],
    ["../orders/../notes", "orders-..-notes.md"],
    ["..", "documentation.md"],
    ["a\u0000\u001f\u007fb", "a-b.md"],
    ["CON", "CON-documentation.md"],
    ["prn", "prn-documentation.md"],
    ["AUX", "AUX-documentation.md"],
    ["NUL.txt", "NUL-documentation.txt.md"],
    ["COM1", "COM1-documentation.md"],
    ["lpt9", "lpt9-documentation.md"],
    ["COM¹", "COM¹-documentation.md"],
    ["LPT².txt", "LPT²-documentation.txt.md"],
    [" notes...  ", "notes.md"],
    ["文書 😀", "文書-😀.md"],
    ["Cafe\u0301", "Café.md"],
    ["", "documentation.md"],
    [" \t\n", "documentation.md"],
    [`${"a".repeat(99)}😀end`, `${"a".repeat(99)}.md`],
    ["文".repeat(120), `${"文".repeat(100)}.md`],
  ])("sanitizes %j", (name, expected) => expect(documentationFileName(name)).toBe(expected));
});

describe("documentation exports", () => {
  it("copies exact stored Markdown with keyboard and polite feedback", async () => {
    const { user: actor } = renderWithQuery(<DocumentationExportActions markdown={markdown} name="Orders API" />);
    const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await actor.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Download Markdown" }));
    await actor.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy Markdown" }));
    await actor.keyboard(" ");
    expect(copy).toHaveBeenCalledWith(markdown);
    expect(screen.getByRole("status").textContent).toBe("Markdown copied");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("reports clipboard failures", async () => {
    const { user: actor } = renderWithQuery(<DocumentationExportActions markdown={markdown} name="Orders" />);
    spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
    await actor.click(screen.getByRole("button", { name: "Copy Markdown" }));
    expect(screen.getByRole("status").textContent).toContain("Could not copy Markdown.");
  });

  it("rejects when clipboard access is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      await expect(copyMarkdown(markdown)).rejects.toThrow("Clipboard access is unavailable");
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("downloads the exact Markdown and derived filename with Enter", async () => {
    const create = spyOn(URL, "createObjectURL").mockReturnValue("blob:markdown");
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let filename = "";
    const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download;
      expect(this.href).toBe("blob:markdown");
      expect(this.isConnected).toBe(true);
    });
    const { user: actor } = renderWithQuery(<DocumentationExportActions markdown={markdown} name="Orders API" />);
    await actor.tab();
    await actor.keyboard("{Enter}");
    expect(click).toHaveBeenCalledTimes(1);
    expect(filename).toBe("Orders-API.md");
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    expect(await blob.text()).toBe(markdown);
    expect(revoke).toHaveBeenCalledWith("blob:markdown");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Markdown downloaded");
  });

  it("keeps empty actions disabled and explains why", () => {
    renderWithQuery(<DocumentationExportActions markdown="" name="Orders" />);
    for (const button of screen.getAllByRole<HTMLButtonElement>("button")) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("No saved documentation to export.");
    }
  });

  it("renders exports in the editor card using the stored value", async () => {
    const onSave = mock(async () => {});
    renderWithQuery(<RichDocumentation name="Orders" value={markdown} onSave={onSave} />);
    const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const card = screen.getByRole("region", { name: "Documentation" });
    fireEvent.change(screen.getByRole("textbox", { name: "Documentation" }), {
      target: { value: "Unsaved local changes" },
    });
    // Click without blurring the editor: export must use the saved prop while a draft exists.
    fireEvent.click(within(card).getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(copy).toHaveBeenCalled());
    expect(copy).toHaveBeenCalledWith(markdown);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers exports on the viewer entity page without save capability", async () => {
    const server = new FakeApi().install();
    try {
      server
        .on("GET /api/auth/me", user())
        .on("GET /api/workspaces", [workspace()])
        .on("GET /api/canvases", [])
        .on("GET /api/canvases/:id/access", { role: "viewer" })
        .on("GET /api/entities/:id", entity(ids.service, "service", "Orders", { documentation: markdown }));
      await renderRoute(`/entities/${ids.service}?canvasId=${ids.canvas}`);
      expect(await screen.findByRole("button", { name: "Copy Markdown" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download Markdown" })).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: "Documentation" })).toBeNull();
      expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
      expect(server.requests("PATCH", `/api/entities/${ids.service}`)).toHaveLength(0);
    } finally {
      server.restore();
    }
  });
});
