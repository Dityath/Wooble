import { describe, expect, it, mock } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import { DocumentationEditor } from "../src/features/inspector/documentation/documentation-editor";
import { readDraft, writeDraft } from "../src/features/inspector/documentation/drafts";
import type { EditorLoader } from "../src/features/inspector/documentation/editor-loader";
import { RichDocumentation } from "../src/features/inspector/rich-documentation";
import {
  AUTOSAVE_DELAY_MS,
  RichDocumentation as LoadedEditor,
} from "../src/features/inspector/rich-documentation-editor";
import { FORBIDDEN_MESSAGE } from "../src/features/inspector/documentation/save-errors";
import { ApiError } from "../src/lib/api";
import { editorFromElement, typeInEditor } from "./support/editor";
import { renderWithQuery } from "./support/render";

const location = { userId: "user-a", kind: "entity", objectId: "entity-1" } as const;
const draftOf = (target: { userId: string; kind: "entity" | "connection"; objectId: string } = location) =>
  readDraft(target.userId, target.kind, target.objectId);

const documentation = () => screen.getByRole("textbox", { name: "Documentation" });
// The visual label shows every state; the live region (role="status") only announces "Saved".
const saveState = () => document.querySelector(".documentation-save-state")?.textContent;
const prompt = () => screen.queryByText(/was kept on this device/)?.closest("p") ?? null;
const findPrompt = async () => {
  await screen.findByText(/was kept on this device/);
  const found = prompt();
  if (!found) throw new Error("The recovery prompt is not shown.");
  return found;
};
const blurDocumentation = () => act(async () => documentation().blur());
const caretToEnd = () =>
  act(() => {
    const editor = editorFromElement(documentation());
    editor.commands.setTextSelection(editor.state.doc.content.size);
  });

type Props = Parameters<typeof RichDocumentation>[0];
async function renderDocumentation(props: Props) {
  const rendered = renderWithQuery(<RichDocumentation {...props} />);
  await screen.findByRole("textbox", { name: "Documentation" });
  return rendered;
}

/** Saves that stay in flight until the test finishes or rejects them, in order. */
function pendingSaves() {
  const settle: Array<{ resolve: () => void; reject: (cause: unknown) => void }> = [];
  const onSave = mock((_value: string) => new Promise<void>((resolve, reject) => settle.push({ resolve, reject })));
  return { onSave, settle };
}

/** Runs `edit` and returns the autosave it schedules, so a test need not wait out the autosave pause. */
async function autosaveAfter(edit: () => Promise<void>) {
  const realSetTimeout = globalThis.setTimeout;
  let autosave: (() => void) | undefined;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === AUTOSAVE_DELAY_MS && typeof handler === "function") autosave = handler as () => void;
    return realSetTimeout(handler, delay, ...args);
  }) as unknown as typeof setTimeout;
  try {
    await edit();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  if (!autosave) throw new Error("No autosave was scheduled.");
  const run = autosave;
  return () => act(async () => run());
}

const reject =
  (status: number, message = "Rejected") =>
  async (_value: string) => {
    throw new ApiError(message, status);
  };

async function typeAndBlur(text: string) {
  await caretToEnd();
  await typeInEditor(documentation(), text);
  await blurDocumentation();
}

describe("documentation drafts", () => {
  it("writes a draft for each edit, including text over the limit", async () => {
    const { onSave } = pendingSaves();
    await renderDocumentation({ value: "Gateway", onSave, draft: location });
    await caretToEnd();
    await typeInEditor(documentation(), " API");
    expect(draftOf()?.markdown).toBe("Gateway API");

    await caretToEnd();
    await typeInEditor(documentation(), " v2");
    expect(draftOf()?.markdown).toBe("Gateway API v2");
  });

  it("keeps an over-limit draft", async () => {
    const initial = `${"word ".repeat(3999)}word`;
    await renderDocumentation({ value: initial, onSave: mock(async () => {}), draft: location });
    await caretToEnd();
    await typeInEditor(documentation(), "bc");
    expect(draftOf()?.markdown).toHaveLength(20_001);
  }, 30_000);

  it("keeps the draft when the save made on unmount fails, and clears it when that save succeeds later", async () => {
    const { onSave, settle } = pendingSaves();
    const view = await renderDocumentation({ value: "", onSave, draft: location });
    await typeInEditor(documentation(), "Rotate keys");
    await act(async () => view.unmount());
    expect(onSave.mock.calls).toEqual([["Rotate keys"]]);
    expect(draftOf()?.markdown).toBe("Rotate keys");

    await act(async () => settle[0].reject(new TypeError("Failed to fetch")));
    expect(draftOf()?.markdown).toBe("Rotate keys");
  });

  it("clears the draft when a save completing after unmount succeeds", async () => {
    const { onSave, settle } = pendingSaves();
    const view = await renderDocumentation({ value: "", onSave, draft: location });
    await typeInEditor(documentation(), "Rotate keys");
    await act(async () => view.unmount());
    expect(draftOf()?.markdown).toBe("Rotate keys");
    await act(async () => settle[0].resolve());
    expect(draftOf()).toBeNull();
  });

  it("clears the draft after a successful save but keeps newer unsaved text", async () => {
    const { onSave, settle } = pendingSaves();
    await renderDocumentation({ value: "", onSave, draft: location });
    await typeAndBlur("First");
    await caretToEnd();
    await typeInEditor(documentation(), " second");
    await act(async () => settle[0].resolve());
    expect(draftOf()?.markdown).toBe("First second");

    await blurDocumentation();
    await act(async () => settle[1].resolve());
    expect(draftOf()).toBeNull();
    await waitFor(() => expect(saveState()).toBe("Saved"));
  });

  it("clears the draft when the text returns to the saved document", async () => {
    await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
    await caretToEnd();
    await typeInEditor(documentation(), "!");
    expect(draftOf()?.markdown).toBe("Saved!");
    await caretToEnd();
    await act(async () => {
      editorFromElement(documentation()).commands.deleteRange({
        from: editorFromElement(documentation()).state.doc.content.size - 2,
        to: editorFromElement(documentation()).state.doc.content.size - 1,
      });
    });
    expect(draftOf()).toBeNull();
  });

  it("does not keep stale in-flight text in the draft when the user edits back to the saved text", async () => {
    const { onSave, settle } = pendingSaves();
    await renderDocumentation({ value: "Saved", onSave, draft: location });
    await caretToEnd();
    await typeInEditor(documentation(), "!");
    await blurDocumentation();
    expect(onSave.mock.calls).toEqual([["Saved!"]]);
    await caretToEnd();
    await act(async () => {
      const editor = editorFromElement(documentation());
      const end = editor.state.doc.content.size;
      editor.commands.deleteRange({ from: end - 2, to: end - 1 });
    });
    expect(documentation().textContent).toBe("Saved");
    expect(draftOf()).toBeNull();

    // The save lands on the server anyway, so the text the user now has differs from it and is kept as the draft.
    await act(async () => settle[0].resolve());
    expect(draftOf()?.markdown).toBe("Saved");
  });

  it("does not read, write or offer drafts without a draft location", async () => {
    writeDraft("user-a", "entity", "entity-1", "Older text");
    const view = await renderDocumentation({ value: "Saved", onSave: mock(async () => {}) });
    expect(screen.queryByText(/was kept on this device/)).toBeNull();
    await caretToEnd();
    await typeInEditor(documentation(), " more");
    expect(draftOf()?.markdown).toBe("Older text");

    // Once the location is known the edits made so far are kept instead of an older draft being offered.
    view.rerender(<RichDocumentation value="Saved" onSave={mock(async () => {})} draft={location} />);
    await waitFor(() => expect(draftOf()?.markdown).toBe("Saved more"));
    expect(screen.queryByText(/was kept on this device/)).toBeNull();
  });

  it("never offers a draft of another user, kind or object", async () => {
    writeDraft("user-a", "entity", "entity-1", "Entity draft of A");
    writeDraft("user-a", "connection", "entity-1", "Connection draft of A");
    await renderDocumentation({
      value: "Saved",
      onSave: mock(async () => {}),
      draft: { userId: "user-b", kind: "entity", objectId: "entity-1" },
    });
    expect(screen.queryByText(/was kept on this device/)).toBeNull();
  });

  it("offers the draft of a connection only to that connection", async () => {
    writeDraft("user-a", "connection", "shared-id", "Connection draft");
    const view = await renderDocumentation({
      value: "Saved",
      onSave: mock(async () => {}),
      draft: { userId: "user-a", kind: "entity", objectId: "shared-id" },
    });
    expect(screen.queryByText(/was kept on this device/)).toBeNull();
    view.rerender(
      <RichDocumentation
        value="Saved"
        onSave={mock(async () => {})}
        draft={{ userId: "user-a", kind: "connection", objectId: "shared-id" }}
      />,
    );
    expect(await screen.findByText(/was kept on this device/)).toBeTruthy();
  });
});

describe("documentation draft recovery", () => {
  it("offers a differing draft without injecting it, and Restore makes it a normal autosaved edit", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    const onSave = mock(async (_value: string) => {});
    await renderDocumentation({ value: "Saved text", onSave, draft: location });
    const offer = await findPrompt();
    expect(offer.getAttribute("role")).toBe("status");
    expect(offer.textContent).toContain("Unsaved documentation from a moment ago was kept on this device.");
    expect(offer.textContent).toContain("Restore or discard it to keep editing.");
    expect(documentation().textContent).toBe("Saved text");

    const autosave = await autosaveAfter(async () => {
      await act(async () => screen.getByRole("button", { name: "Restore" }).click());
    });
    expect(documentation().textContent).toBe("Draft text");
    expect(prompt()).toBeNull();
    // Focus returns to the editor instead of dropping to the body when the Restore button goes away.
    expect(document.activeElement).toBe(documentation());
    expect(documentation().getAttribute("contenteditable")).toBe("true");
    expect(saveState()).toBe("Unsaved changes");
    await autosave();
    expect(onSave.mock.calls).toEqual([["Draft text"]]);
    await waitFor(() => expect(draftOf()).toBeNull());
  });

  it("shows the over-limit state for a restored draft that is too long", async () => {
    writeDraft("user-a", "entity", "entity-1", "x".repeat(20_005));
    await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
    await act(async () => (await screen.findByRole("button", { name: "Restore" })).click());
    expect(await screen.findByText("Remove 5 characters to save.")).toBeTruthy();
  }, 30_000);

  it("describes how old the draft is", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 60 * 1000;
    try {
      await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
      expect((await findPrompt()).textContent).toContain("from 3 hours ago");
    } finally {
      Date.now = realNow;
    }
  });

  it("Discard removes the stored draft", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
    await act(async () => (await screen.findByRole("button", { name: "Discard saved copy" })).click());
    expect(draftOf()).toBeNull();
    expect(prompt()).toBeNull();
    expect(documentation().textContent).toBe("Saved");
    expect(document.activeElement).toBe(documentation());
  });

  it("clears a draft that equals the saved documentation without asking", async () => {
    writeDraft("user-a", "entity", "entity-1", "Saved");
    await renderDocumentation({ value: "Saved\n", onSave: mock(async () => {}), draft: location });
    await waitFor(() => expect(draftOf()).toBeNull());
    expect(prompt()).toBeNull();
  });

  it("hides the prompt when the draft location goes away, and stops writing", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    const onSave = mock(async (_value: string) => {});
    const view = await renderDocumentation({ value: "Saved", onSave, draft: location });
    await findPrompt();
    view.rerender(<RichDocumentation value="Saved" onSave={onSave} />);
    await waitFor(() => expect(prompt()).toBeNull());
    expect(draftOf()?.markdown).toBe("Draft text");
    await caretToEnd();
    await typeInEditor(documentation(), " more");
    expect(draftOf()?.markdown).toBe("Draft text");
  });

  it("keeps the editor read-only while the offer is shown, so typing cannot overwrite the older draft", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
    await findPrompt();
    expect(documentation().getAttribute("contenteditable")).toBe("false");
    expect(draftOf()?.markdown).toBe("Draft text");

    await act(async () => screen.getByRole("button", { name: "Discard saved copy" }).click());
    expect(documentation().getAttribute("contenteditable")).toBe("true");
  });

  it("clears a draft that only differs from the documentation in Markdown syntax without asking", async () => {
    writeDraft("user-a", "entity", "entity-1", "- one\n- two");
    const onSave = mock(async (_value: string) => {});
    await renderDocumentation({ value: "* one\n* two", onSave, draft: location });
    await waitFor(() => expect(draftOf()).toBeNull());
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("failed documentation saves", () => {
  it("403 keeps the typed text visible but read-only, clears the draft, focuses the notice and never saves again", async () => {
    const onSave = mock(reject(403, "You do not have access to this resource"));
    const onUnsavedChange = mock((_unsaved: boolean) => {});
    await renderDocumentation({ value: "Server text", onSave, draft: location, onUnsavedChange });
    await caretToEnd();
    await typeAndBlur(" local");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(FORBIDDEN_MESSAGE);
    expect(alert.textContent).toContain("ask a canvas manager for edit access");
    // The editor stays mounted with the user's text, which can no longer be changed.
    expect(documentation().textContent).toBe("Server text local");
    expect(documentation().getAttribute("contenteditable")).toBe("false");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getAllByText(/can no longer edit/)).toHaveLength(1);
    expect(document.activeElement).toBe(alert);
    expect(draftOf()).toBeNull();
    expect(onUnsavedChange.mock.calls.at(-1)).toEqual([false]);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("403 after unmount clears the draft and keeps queued saves from running", async () => {
    const { onSave, settle } = pendingSaves();
    const view = await renderDocumentation({ value: "", onSave, draft: location });
    await typeAndBlur("One");
    await caretToEnd();
    await typeInEditor(documentation(), " two");
    await act(async () => view.unmount());
    // The second save waits behind the first.
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => settle[0].reject(new ApiError("Forbidden", 403)));
    expect(draftOf()).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("400 shows the server message without Retry and keeps the draft; a new edit saves again", async () => {
    let accept = false;
    const onSave = mock(async (_value: string) => {
      if (!accept) throw new ApiError("Documentation is not valid", 400);
    });
    await renderDocumentation({ value: "", onSave, draft: location });
    await typeAndBlur("Bad");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The server rejected this documentation: Documentation is not valid. Edit it and try again.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(draftOf()?.markdown).toBe("Bad");
    // The same content is not submitted again on blur.
    await act(async () => documentation().focus());
    await blurDocumentation();
    expect(onSave).toHaveBeenCalledTimes(1);

    accept = true;
    await typeAndBlur("er");
    await waitFor(() => expect(onSave.mock.calls.at(-1)).toEqual(["Bader"]));
    await waitFor(() => expect(draftOf()).toBeNull());
  });

  it.each([400, 404, 409, 410, 413, 418, 422])(
    "%i is permanent: a message, no Retry, the draft kept",
    async (status) => {
      await renderDocumentation({ value: "", onSave: mock(reject(status, "Rejected")), draft: location });
      await typeAndBlur("Bad");
      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(draftOf()?.markdown).toBe("Bad");
    },
  );

  it.each([408, 429, 500, 503])("%i is transient and can be retried", async (status) => {
    await renderDocumentation({ value: "", onSave: mock(reject(status, "Try later")), draft: location });
    await typeAndBlur("Later");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(draftOf()?.markdown).toBe("Later");
  });

  it("401 explains the ended session, keeps the draft, never retries by itself and offers a manual Retry", async () => {
    let signedIn = false;
    const onSave = mock(async (_value: string) => {
      if (!signedIn) throw new ApiError("Unauthorized", 401);
    });
    const { user: actor } = await renderDocumentation({ value: "", onSave, draft: location });
    await typeAndBlur("Keep me");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Your session has ended. Sign in again, then choose Retry. Your text is kept on this device.",
    );
    expect(draftOf()?.markdown).toBe("Keep me");
    expect(documentation().textContent).toBe("Keep me");
    await act(async () => documentation().focus());
    await blurDocumentation();
    expect(onSave).toHaveBeenCalledTimes(1);

    signedIn = true;
    await actor.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(saveState()).toBe("Saved"));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(draftOf()).toBeNull();
  });

  it.each([
    ["a network error", () => new TypeError("Failed to fetch")],
    ["a server error", () => new ApiError("Internal Server Error", 500)],
  ])("%s can be retried and keeps the draft", async (_name, failure) => {
    let fail = true;
    const onSave = mock(async (_value: string) => {
      if (fail) throw failure();
    });
    const { user: actor } = await renderDocumentation({ value: "", onSave, draft: location });
    await typeAndBlur("Keep me");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(saveState()).toBe("Save failed");
    expect(draftOf()?.markdown).toBe("Keep me");

    fail = false;
    await actor.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(saveState()).toBe("Saved"));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(draftOf()).toBeNull();
    // The Retry button went away; the focus returns to the editor instead of dropping to the body.
    expect(document.activeElement).toBe(documentation());
  });
});

describe("documentation over the length limit", () => {
  it("states the excess, offers no Retry and keeps the draft", async () => {
    const initial = `${"word ".repeat(3999)}word`;
    const onSave = mock(async (_value: string) => {});
    await renderDocumentation({ value: initial, onSave, draft: location });
    await caretToEnd();
    await typeInEditor(documentation(), "b".repeat(1234));
    await blurDocumentation();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Documentation is over the 20,000-character limit.").getAttribute("role")).toBe("status");
    expect(screen.getByText("Remove 1,233 characters to save.").hasAttribute("role")).toBe(false);
    expect(documentation().getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(draftOf()?.markdown).toHaveLength(initial.length + 1234);
  }, 30_000);
});

describe("leaving with unsaved documentation", () => {
  function beforeUnload() {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it("warns while content is unsaved or in flight and stops once everything is saved", async () => {
    const { onSave, settle } = pendingSaves();
    const onUnsavedChange = mock((_unsaved: boolean) => {});
    await renderDocumentation({ value: "", onSave, onUnsavedChange });
    expect(beforeUnload().defaultPrevented).toBe(false);

    await typeInEditor(documentation(), "Draft");
    expect(beforeUnload().defaultPrevented).toBe(true);
    expect((beforeUnload() as unknown as { returnValue: string }).returnValue).toBe("");
    expect(onUnsavedChange.mock.calls).toEqual([[true]]);

    await blurDocumentation();
    expect(beforeUnload().defaultPrevented).toBe(true);
    await act(async () => settle[0].resolve());
    expect(beforeUnload().defaultPrevented).toBe(false);
    expect(onUnsavedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("warns after a failed save", async () => {
    await renderDocumentation({ value: "", onSave: mock(reject(500)) });
    await typeAndBlur("Draft");
    await screen.findByRole("alert");
    expect(beforeUnload().defaultPrevented).toBe(true);
  });

  it("warns while the document is over the limit", async () => {
    const onUnsavedChange = mock((_unsaved: boolean) => {});
    await renderDocumentation({ value: `${"word ".repeat(3999)}word`, onSave: mock(async () => {}), onUnsavedChange });
    await caretToEnd();
    await typeInEditor(documentation(), "bc");
    expect(beforeUnload().defaultPrevented).toBe(true);
    expect(onUnsavedChange.mock.calls).toEqual([[true]]);
  }, 30_000);

  it("removes the warning when the editor unmounts", async () => {
    const onUnsavedChange = mock((_unsaved: boolean) => {});
    const view = await renderDocumentation({ value: "", onSave: pendingSaves().onSave, onUnsavedChange });
    await typeInEditor(documentation(), "Draft");
    expect(beforeUnload().defaultPrevented).toBe(true);
    await act(async () => view.unmount());
    expect(beforeUnload().defaultPrevented).toBe(false);
    expect(onUnsavedChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe("documentation changed elsewhere after a blur-initiated save", () => {
  it("keeps the user's text while the save is in flight and does not replace it with the stale update afterwards", async () => {
    const { onSave, settle } = pendingSaves();
    const view = await renderDocumentation({ value: "Original", onSave });
    await typeAndBlur(" mine");
    expect(onSave.mock.calls).toEqual([["Original mine"]]);

    view.rerender(<RichDocumentation value="Theirs" onSave={onSave} />);
    expect(documentation().textContent).toBe("Original mine");

    await act(async () => settle[0].resolve());
    await waitFor(() => expect(saveState()).toBe("Saved"));
    // The user's save was the last write, so leaving the editor again must not bring the older update back.
    await act(async () => documentation().focus());
    await blurDocumentation();
    expect(documentation().textContent).toBe("Original mine");
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the update parked and the user's text when the blur-initiated save fails", async () => {
    const { onSave, settle } = pendingSaves();
    const view = await renderDocumentation({ value: "Original", onSave });
    await typeAndBlur(" mine");
    view.rerender(<RichDocumentation value="Theirs" onSave={onSave} />);
    await act(async () => settle[0].reject(new TypeError("Failed to fetch")));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    // Unsaved text is never replaced silently, even when the editor loses focus again.
    await act(async () => documentation().focus());
    await blurDocumentation();
    expect(documentation().textContent).toBe("Original mine");
  });

  it("shows an update that arrives after the save completed", async () => {
    const onSave = mock(async (_value: string) => {});
    const view = await renderDocumentation({ value: "Original", onSave });
    await typeAndBlur(" mine");
    await waitFor(() => expect(saveState()).toBe("Saved"));
    view.rerender(<RichDocumentation value="Theirs" onSave={onSave} />);
    await waitFor(() => expect(documentation().textContent).toBe("Theirs"));
  });
});

describe("documentation editor chunk", () => {
  /** Like a browser: a dynamic import that failed once keeps failing for the same address until the page reloads. */
  function failingLoader() {
    const calls: number[] = [];
    const load: EditorLoader = () => {
      calls.push(calls.length);
      return Promise.reject(new Error("Failed to fetch dynamically imported module"));
    };
    return { load, calls };
  }

  it("shows a readable fallback when the chunk fails to load, and Reload reloads the page", async () => {
    const { load, calls } = failingLoader();
    const reload = mock(() => {});
    const consoleError = console.error;
    console.error = () => {};
    try {
      const { user: actor } = renderWithQuery(
        <div>
          <p>Sibling content</p>
          <RichDocumentation
            load={load}
            reload={reload}
            value={"# Runbook\n\nRestart **workers**"}
            onSave={mock(async () => {})}
          />
        </div>,
      );
      expect((await screen.findByRole("alert")).textContent).toContain(
        "The documentation editor could not load. Reload the page to try again. The documentation is shown below.",
      );
      expect(screen.getByRole("heading", { name: "Runbook" })).toBeTruthy();
      expect(screen.getByText("workers").tagName).toBe("STRONG");
      expect(screen.getByText("Sibling content")).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

      expect(reload).not.toHaveBeenCalled();
      await actor.click(screen.getByRole("button", { name: "Reload" }));
      expect(reload).toHaveBeenCalledTimes(1);
      // Reloading is the only recovery: the import is not attempted again in place.
      expect(calls).toHaveLength(1);
      expect(screen.getByText("Sibling content")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Runbook" })).toBeTruthy();
    } finally {
      console.error = consoleError;
    }
  });

  it("loads the editor when the chunk is available", async () => {
    const load: EditorLoader = () => Promise.resolve({ default: LoadedEditor });
    renderWithQuery(<RichDocumentation load={load} value="Notes" onSave={async () => {}} />);
    expect(await screen.findByRole("textbox", { name: "Documentation" })).toBeTruthy();
  });
});

describe("aria-invalid on the editing surfaces", () => {
  const noop = () => {};
  it("sets and clears aria-invalid on the editor element itself, keeping the attributes it already has", async () => {
    const { rerender } = render(<DocumentationEditor initialMarkdown="Hello" onChange={noop} onBlur={noop} />);
    const editable = await screen.findByRole("textbox", { name: "Documentation" });
    expect(editable.hasAttribute("aria-invalid")).toBe(false);
    rerender(<DocumentationEditor initialMarkdown="Hello" onChange={noop} onBlur={noop} invalid />);
    await waitFor(() => expect(editable.getAttribute("aria-invalid")).toBe("true"));
    expect(editable.getAttribute("aria-label")).toBe("Documentation");
    expect(editable.getAttribute("aria-multiline")).toBe("true");
    expect(editable.getAttribute("data-inline-editing")).toBe("true");
    rerender(<DocumentationEditor initialMarkdown="Hello" onChange={noop} onBlur={noop} />);
    await waitFor(() => expect(editable.hasAttribute("aria-invalid")).toBe(false));
    expect(editable.getAttribute("aria-label")).toBe("Documentation");
  });

  it("sets aria-invalid on the source textarea", async () => {
    const source = "<Button>x</Button>";
    const { rerender } = render(<DocumentationEditor initialMarkdown={source} onChange={noop} onBlur={noop} invalid />);
    const area = await screen.findByRole("textbox", { name: "Documentation" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.getAttribute("aria-invalid")).toBe("true");
    rerender(<DocumentationEditor initialMarkdown={source} onChange={noop} onBlur={noop} />);
    expect(area.hasAttribute("aria-invalid")).toBe(false);
  });
});
