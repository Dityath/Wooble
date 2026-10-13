import { describe, expect, it, mock } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import { readDraft, writeDraft } from "../src/features/inspector/documentation/drafts";
import type { EditorLoader } from "../src/features/inspector/documentation/editor-loader";
import { RichDocumentation } from "../src/features/inspector/rich-documentation";
import { RichDocumentation as LoadedEditor } from "../src/features/inspector/rich-documentation-editor";
import { ApiError } from "../src/lib/api";
import { editorFromElement, typeInEditor } from "./support/editor";
import { renderWithQuery } from "./support/render";

const location = { userId: "user-a", kind: "entity", objectId: "entity-1" } as const;
const draftOf = (target: { userId: string; kind: "entity" | "connection"; objectId: string } = location) =>
  readDraft(target.userId, target.kind, target.objectId);

const documentation = () => screen.getByRole("textbox", { name: "Documentation" });
const saveState = () => screen.getByRole("status").textContent;
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

/** Runs `edit` and returns the autosave it schedules, so a test need not wait out the 900 ms pause. */
async function autosaveAfter(edit: () => Promise<void>) {
  const realSetTimeout = globalThis.setTimeout;
  let autosave: (() => void) | undefined;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 900 && typeof handler === "function") autosave = handler as () => void;
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
    const prompt = await screen.findByRole("region", { name: "Unsaved documentation found" });
    expect(prompt.textContent).toContain("Unsaved documentation from a moment ago was kept on this device.");
    expect(documentation().textContent).toBe("Saved text");

    const autosave = await autosaveAfter(async () => {
      await act(async () => screen.getByRole("button", { name: "Restore" }).click());
    });
    expect(documentation().textContent).toBe("Draft text");
    expect(screen.queryByRole("region", { name: "Unsaved documentation found" })).toBeNull();
    expect(saveState()).toBe("Unsaved changes");
    await autosave();
    expect(onSave.mock.calls).toEqual([["Draft text"]]);
    await waitFor(() => expect(draftOf()).toBeNull());
  });

  it("shows the over-limit state for a restored draft that is too long", async () => {
    writeDraft("user-a", "entity", "entity-1", "x".repeat(20_005));
    await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
    await act(async () => (await screen.findByRole("button", { name: "Restore" })).click());
    expect((await screen.findByRole("alert")).textContent).toContain("Remove 5 characters to save.");
  }, 30_000);

  it("describes how old the draft is", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 60 * 1000;
    try {
      await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
      expect((await screen.findByRole("region", { name: "Unsaved documentation found" })).textContent).toContain(
        "from 3 hours ago",
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("Discard removes the stored draft", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
    await act(async () => (await screen.findByRole("button", { name: "Discard" })).click());
    expect(draftOf()).toBeNull();
    expect(screen.queryByRole("region", { name: "Unsaved documentation found" })).toBeNull();
    expect(documentation().textContent).toBe("Saved");
  });

  it("clears a draft that equals the saved documentation without asking", async () => {
    writeDraft("user-a", "entity", "entity-1", "Saved");
    await renderDocumentation({ value: "Saved\n", onSave: mock(async () => {}), draft: location });
    await waitFor(() => expect(draftOf()).toBeNull());
    expect(screen.queryByRole("region", { name: "Unsaved documentation found" })).toBeNull();
  });

  it("hides the prompt when the draft location goes away, and stops writing", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    const onSave = mock(async (_value: string) => {});
    const view = await renderDocumentation({ value: "Saved", onSave, draft: location });
    await screen.findByRole("region", { name: "Unsaved documentation found" });
    view.rerender(<RichDocumentation value="Saved" onSave={onSave} />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved documentation found" })).toBeNull());
    expect(draftOf()?.markdown).toBe("Draft text");
    await caretToEnd();
    await typeInEditor(documentation(), " more");
    expect(draftOf()?.markdown).toBe("Draft text");
  });

  it("withdraws the offer when the user starts typing", async () => {
    writeDraft("user-a", "entity", "entity-1", "Draft text");
    await renderDocumentation({ value: "Saved", onSave: mock(async () => {}), draft: location });
    await screen.findByRole("region", { name: "Unsaved documentation found" });
    await caretToEnd();
    await typeInEditor(documentation(), "!");
    expect(screen.queryByRole("region", { name: "Unsaved documentation found" })).toBeNull();
    expect(draftOf()?.markdown).toBe("Saved!");
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
  it("403 turns the editor read-only, clears the draft, offers no Retry and never saves again", async () => {
    const onSave = mock(reject(403, "You do not have access to this resource"));
    const onUnsavedChange = mock((_unsaved: boolean) => {});
    await renderDocumentation({ value: "Server text", onSave, draft: location, onUnsavedChange });
    await caretToEnd();
    await typeAndBlur(" local");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You can no longer edit this documentation.");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/local/)).toBeNull();
    expect(screen.getByText("Server text")).toBeTruthy();
    expect(draftOf()).toBeNull();
    expect(onUnsavedChange.mock.calls.at(-1)).toEqual([false]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
    expect((await screen.findByRole("alert")).textContent).toContain("Documentation is not valid");
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

  it("422 is permanent too", async () => {
    await renderDocumentation({ value: "", onSave: mock(reject(422, "Unprocessable")), draft: location });
    await typeAndBlur("Bad");
    expect((await screen.findByRole("alert")).textContent).toContain("Unprocessable");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("401 reports the ended session without a retry loop and keeps the draft", async () => {
    const onSave = mock(reject(401, "Unauthorized"));
    await renderDocumentation({ value: "", onSave, draft: location });
    await typeAndBlur("Keep me");
    expect((await screen.findByRole("alert")).textContent).toContain("Your session has ended. Sign in again to save.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(draftOf()?.markdown).toBe("Keep me");
    expect(documentation().textContent).toBe("Keep me");
    await blurDocumentation();
    expect(onSave).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole("alert").textContent).toBe(
      "Documentation is limited to 20,000 characters of Markdown. Remove 1,233 characters to save.",
    );
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

  it("keeps the update parked when the blur-initiated save fails, and shows it only after the user's text is safe", async () => {
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
  it("shows a readable fallback when the chunk fails to load and retries the import", async () => {
    const calls: number[] = [];
    const load: EditorLoader = () => {
      calls.push(calls.length);
      if (calls.length === 1) return Promise.reject(new Error("Failed to fetch dynamically imported module"));
      return Promise.resolve({ default: LoadedEditor });
    };
    const consoleError = console.error;
    console.error = () => {};
    try {
      const { user: actor } = renderWithQuery(
        <div>
          <p>Sibling content</p>
          <RichDocumentation load={load} value={"# Runbook\n\nRestart **workers**"} onSave={mock(async () => {})} />
        </div>,
      );
      expect((await screen.findByRole("alert")).textContent).toContain("The documentation editor could not load.");
      expect(screen.getByRole("heading", { name: "Runbook" })).toBeTruthy();
      expect(screen.getByText("workers").tagName).toBe("STRONG");
      expect(screen.getByText("Sibling content")).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();

      await actor.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByRole("textbox", { name: "Documentation" })).toBeTruthy();
      expect(calls).toHaveLength(2);
      expect(screen.queryByText("The documentation editor could not load.")).toBeNull();
      expect(screen.getByText("Sibling content")).toBeTruthy();
    } finally {
      console.error = consoleError;
    }
  });

  it("stays on the fallback when the retry fails too", async () => {
    const load: EditorLoader = () => Promise.reject(new Error("offline"));
    const consoleError = console.error;
    console.error = () => {};
    try {
      const { user: actor } = renderWithQuery(<RichDocumentation load={load} value="Notes" onSave={async () => {}} />);
      await screen.findByRole("alert");
      await actor.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.getByText("Notes")).toBeTruthy();
    } finally {
      console.error = consoleError;
    }
  });
});
