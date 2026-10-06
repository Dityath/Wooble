import { describe, expect, it } from "bun:test";
import { unsupportedMarkdown } from "../src/features/inspector/documentation/unsupported-markdown";

describe("unsupported documentation Markdown", () => {
  it.each([
    ["![Diagram](https://example.com/diagram.png)", "images"],
    ["![Diagram][diagram]\n\n[diagram]: diagram.png", "images"],
    ["Claim[^1]\n\n[^1]: Source.", "footnotes"],
    ["Claim[^missing]", "footnotes"],
    ["---\ntitle: Payments\n---\n\nNotes", "YAML front matter"],
    ["---\r\ntitle: Payments\r\n...\r\nNotes", "YAML front matter"],
    ["Press <kbd>Ctrl</kbd>", "raw HTML"],
    ["<!-- internal note -->", "raw HTML"],
    ["<details>\n<summary>Notes</summary>\n</details>", "raw HTML"],
  ])("detects %s before it is parsed into blocks", (source, kind) => {
    expect(unsupportedMarkdown(source)).toContain(kind);
  });

  it.each([
    "```md\n![Diagram](diagram.png)\nClaim[^1]\n[^1]: Source.\n<details>\n```",
    "`![Diagram](diagram.png)` and `[^1]` and `<kbd>`",
    "\\![Diagram](diagram.png) and \\[\\^1] and &lt;kbd&gt;",
    "First<br>Second<br />Third",
    "https://example.com and <https://example.com>",
    "Notes\n\n---\n\nMore notes",
  ])("keeps supported or literal syntax in blocks: %s", (source) => {
    expect(unsupportedMarkdown(source)).toEqual([]);
  });
});
