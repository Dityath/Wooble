export function documentationFileName(name: string): string {
  let base = name
    .normalize("NFC")
    // Control characters and filesystem separators become word boundaries.
    .replace(/[\p{Cc}<>:"/\\|?*\s]+/gu, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "");
  base = base.replace(/[-. ]+$/g, "") || "documentation";
  // Windows also reserves these names when followed by an extension.
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base)) {
    base = base.replace(/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])/i, "$1-documentation");
  }
  let capped = "";
  const encoder = new TextEncoder();
  let bytes = encoder.encode(".md").length;
  for (const character of base) {
    const size = encoder.encode(character).length;
    if (bytes + size > 200) break;
    capped += character;
    bytes += size;
  }
  return `${capped.replace(/[-. ]+$/g, "")}.md`;
}

export function downloadMarkdown(markdown: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function copyMarkdown(markdown: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
  await navigator.clipboard.writeText(markdown);
}
