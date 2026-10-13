import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  clearAllDocumentationDrafts,
  clearDraft,
  type DocumentationDraft,
  draftKey,
  pruneDocumentationDrafts,
  resumeDocumentationDrafts,
  suspendDocumentationDrafts,
  readDraft,
  writeDraft,
} from "../src/features/inspector/documentation/drafts";

const USER = "user-1";
const OTHER_USER = "user-2";
const OBJECT = "object-1";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Writes a draft's raw JSON, as a stored entry that a different version, a browser extension, or a user could leave. */
function putRaw(value: string, key = draftKey(USER, "entity", OBJECT)): void {
  localStorage.setItem(key, value);
}

/** The `DOMException` a browser raises when the store refuses the operation, as Safari's private mode does. */
const refusing = (name: string) => (): never => {
  throw new DOMException("The operation is insecure.", name);
};

/**
 * Replaces one `localStorage` member for the duration of a test, as a private-mode browser or a full store does.
 * happy-dom's `Storage` ignores plain assignment, so the member is redefined and put back afterwards.
 */
function withBrokenStorage(member: string, replacement: PropertyDescriptor, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(localStorage), member);
  Object.defineProperty(localStorage, member, { configurable: true, ...replacement });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(localStorage, member, original);
  }
}

afterEach(() => setSystemTime());

describe("documentation draft keys", () => {
  it("namespaces a draft by user, object kind, and object", () => {
    expect(draftKey(USER, "entity", OBJECT)).toBe(`wooble:draft:v1:${USER}:entity:${OBJECT}`);
    expect(draftKey(USER, "connection", OBJECT)).toBe(`wooble:draft:v1:${USER}:connection:${OBJECT}`);
  });

  it("encodes each segment so an id cannot forge another key", () => {
    // A hostile id that appends segments would otherwise read, or overwrite, a different user's draft.
    const forged = draftKey("user-1:entity:object-1", "entity", "object-1");
    expect(forged).toBe("wooble:draft:v1:user-1%3Aentity%3Aobject-1:entity:object-1");
    expect(forged).not.toBe(draftKey(USER, "entity", OBJECT));
    expect(draftKey(USER, "entity", "a/b")).toBe("wooble:draft:v1:user-1:entity:a%2Fb");
  });
});

describe("documentation draft round trip", () => {
  it("returns the written Markdown and a numeric timestamp", () => {
    writeDraft(USER, "entity", OBJECT, "# Payments\n\nRetries are exponential.");
    const draft = readDraft(USER, "entity", OBJECT);
    expect(draft?.markdown).toBe("# Payments\n\nRetries are exponential.");
    expect(typeof draft?.savedAt).toBe("number");
    expect(draft?.savedAt).toBeGreaterThan(0);
  });

  it("returns null when nothing was ever written", () => {
    expect(readDraft(USER, "entity", "never-written")).toBeNull();
  });

  it("keeps Markdown longer than the 20,000 character server limit", () => {
    // Over-limit text is what the server refuses to save, so it is what the draft most has to keep.
    const markdown = `# Payments\n\n${"detail ".repeat(4_000)}`;
    expect(markdown.length).toBeGreaterThan(20_000);
    writeDraft(USER, "entity", OBJECT, markdown);
    expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe(markdown);
  });
});

describe("documentation draft isolation", () => {
  it("keeps each user's drafts apart", () => {
    writeDraft(USER, "entity", OBJECT, "mine");
    writeDraft(OTHER_USER, "entity", OBJECT, "theirs");
    expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe("mine");
    expect(readDraft(OTHER_USER, "entity", OBJECT)?.markdown).toBe("theirs");

    clearDraft(USER, "entity", OBJECT);
    expect(readDraft(USER, "entity", OBJECT)).toBeNull();
    expect(readDraft(OTHER_USER, "entity", OBJECT)?.markdown).toBe("theirs");
  });

  it("keeps an entity and a connection apart under the same id", () => {
    // Entities and connections are different objects that share a column; their ids never collide in practice, so the
    // kind is part of the key to keep a same-shaped id from one kind from overwriting the other.
    const sharedId = "shared-id";
    writeDraft(USER, "entity", sharedId, "entity draft");
    writeDraft(USER, "connection", sharedId, "connection draft");
    expect(readDraft(USER, "entity", sharedId)?.markdown).toBe("entity draft");
    expect(readDraft(USER, "connection", sharedId)?.markdown).toBe("connection draft");

    writeDraft(USER, "entity", sharedId, "entity draft, rewritten");
    expect(readDraft(USER, "connection", sharedId)?.markdown).toBe("connection draft");
  });

  it("keeps two different objects of one kind apart", () => {
    writeDraft(USER, "entity", "left", "left draft");
    writeDraft(USER, "entity", "right", "right draft");
    expect(readDraft(USER, "entity", "left")?.markdown).toBe("left draft");
    expect(readDraft(USER, "entity", "right")?.markdown).toBe("right draft");

    clearDraft(USER, "entity", "left");
    expect(readDraft(USER, "entity", "left")).toBeNull();
    expect(readDraft(USER, "entity", "right")?.markdown).toBe("right draft");
  });
});

describe("documentation draft blank writes", () => {
  it.each(["", "   ", "\n\t "])(
    "stores blank Markdown as a draft, because deleting everything is an edit: %p",
    (blank) => {
      writeDraft(USER, "entity", OBJECT, "worth keeping");
      writeDraft(USER, "entity", OBJECT, blank);
      expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe(blank);
      expect(localStorage.getItem(draftKey(USER, "entity", OBJECT))).not.toBeNull();
    },
  );
});

describe("documentation draft expiry", () => {
  it("keeps a draft written just inside the retention window", () => {
    const writtenAt = new Date("2026-03-01T12:00:00.000Z");
    setSystemTime(writtenAt);
    writeDraft(USER, "entity", OBJECT, "recent");
    setSystemTime(new Date(writtenAt.getTime() + WEEK_MS - 1_000));
    expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe("recent");
  });

  it("refuses a draft older than seven days instead of resurrecting it", () => {
    const writtenAt = new Date("2026-03-01T12:00:00.000Z");
    setSystemTime(writtenAt);
    writeDraft(USER, "entity", OBJECT, "months old");
    // Moving the clock forward is what happens to a draft left behind by someone who has not returned for weeks.
    setSystemTime(new Date(writtenAt.getTime() + WEEK_MS + 1_000));
    expect(readDraft(USER, "entity", OBJECT)).toBeNull();
  });

  it("refuses a stored timestamp from before the window", () => {
    const stale: DocumentationDraft = { markdown: "stale", savedAt: Date.now() - WEEK_MS - 1_000 };
    putRaw(JSON.stringify(stale));
    expect(readDraft(USER, "entity", OBJECT)).toBeNull();
  });
});

describe("documentation draft malformed storage", () => {
  it.each([
    ["not json", "unparseable JSON"],
    ["{}", "an object with no fields"],
    ['{"markdown":5,"savedAt":1}', "a non-string markdown"],
    ['{"markdown":"x","savedAt":"soon"}', "a non-numeric savedAt"],
    ['{"markdown":"x","savedAt":null}', "a null savedAt"],
    ['{"markdown":"x","savedAt":1e999}', "an infinite savedAt"],
    ["null", "a JSON null"],
    ['"just a string"', "a JSON string"],
    ["[]", "an array"],
  ])("reads %s as absent without throwing: %s", (raw) => {
    putRaw(raw);
    expect(() => readDraft(USER, "entity", OBJECT)).not.toThrow();
    expect(readDraft(USER, "entity", OBJECT)).toBeNull();
  });
});

describe("documentation draft without a known user", () => {
  it.each(["", undefined as unknown as string])("stores and reads nothing for user id %p", (userId) => {
    writeDraft(userId, "entity", OBJECT, "should not be stored");
    expect(readDraft(userId, "entity", OBJECT)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("does not read the draft of the user who used this browser last", () => {
    writeDraft(USER, "entity", OBJECT, "previous session");
    expect(readDraft("", "entity", OBJECT)).toBeNull();
    expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe("previous session");
  });
});

describe("documentation draft storage failures", () => {
  it("swallows a store that refuses to write", () => {
    withBrokenStorage("setItem", { value: refusing("QuotaExceededError") }, () => {
      expect(() => writeDraft(USER, "entity", OBJECT, "quota exhausted")).not.toThrow();
    });
    expect(readDraft(USER, "entity", OBJECT)).toBeNull();
  });

  it("swallows a store that refuses to read", () => {
    writeDraft(USER, "entity", OBJECT, "unreadable");
    withBrokenStorage("getItem", { value: refusing("SecurityError") }, () => {
      expect(() => readDraft(USER, "entity", OBJECT)).not.toThrow();
      expect(readDraft(USER, "entity", OBJECT)).toBeNull();
    });
  });

  it("swallows a store that refuses to remove", () => {
    withBrokenStorage("removeItem", { value: refusing("SecurityError") }, () => {
      expect(() => clearDraft(USER, "entity", OBJECT)).not.toThrow();
      expect(() => clearAllDocumentationDrafts()).not.toThrow();
    });
  });

  it("swallows a store that cannot be enumerated", () => {
    withBrokenStorage("key", { value: refusing("SecurityError") }, () => {
      expect(() => clearAllDocumentationDrafts()).not.toThrow();
    });
    withBrokenStorage("length", { get: refusing("SecurityError") }, () => {
      expect(() => clearAllDocumentationDrafts()).not.toThrow();
    });
  });
});

describe("clearing every documentation draft", () => {
  it("removes every user's drafts and leaves the rest of localStorage alone", () => {
    writeDraft(USER, "entity", OBJECT, "one");
    writeDraft(USER, "entity", "object-2", "two");
    writeDraft(USER, "connection", OBJECT, "three");
    writeDraft(OTHER_USER, "connection", OBJECT, "four");
    localStorage.setItem("wooble-theme", "dark");
    localStorage.setItem("unrelated", "keep me");
    // A key that only starts with the same letters is not this module's to delete.
    localStorage.setItem("wooble:draft", "not a draft");

    clearAllDocumentationDrafts();

    expect(Object.keys(localStorage).sort()).toEqual(["unrelated", "wooble-theme", "wooble:draft"]);
    expect(localStorage.getItem("wooble-theme")).toBe("dark");
    expect(localStorage.getItem("unrelated")).toBe("keep me");
    expect(localStorage.getItem("wooble:draft")).toBe("not a draft");
    expect(readDraft(USER, "entity", OBJECT)).toBeNull();
    expect(readDraft(USER, "entity", "object-2")).toBeNull();
    expect(readDraft(USER, "connection", OBJECT)).toBeNull();
    expect(readDraft(OTHER_USER, "connection", OBJECT)).toBeNull();
  });

  it("does nothing when there is nothing to clear", () => {
    localStorage.setItem("wooble-theme", "light");
    clearAllDocumentationDrafts();
    expect(localStorage.getItem("wooble-theme")).toBe("light");
  });
});

describe("suspending documentation drafts", () => {
  afterEach(() => resumeDocumentationDrafts());

  it("neither writes nor reads while suspended, and works again once resumed", () => {
    writeDraft(USER, "entity", OBJECT, "before");
    suspendDocumentationDrafts();
    writeDraft(USER, "entity", OBJECT, "during");
    expect(readDraft(USER, "entity", OBJECT)).toBeNull();
    resumeDocumentationDrafts();
    expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe("before");
    writeDraft(USER, "entity", OBJECT, "after");
    expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe("after");
  });

  it("cannot write back after a purge while suspended", () => {
    writeDraft(USER, "entity", OBJECT, "unsaved");
    suspendDocumentationDrafts();
    clearAllDocumentationDrafts();
    writeDraft(USER, "entity", OBJECT, "late write from an unmounting editor");
    expect(localStorage.length).toBe(0);
  });
});

describe("pruning documentation drafts", () => {
  const key = (userId: string, id: string) => draftKey(userId, "entity", id);

  it("removes expired entries and other users' entries, and keeps the current user's", () => {
    const now = Date.now();
    putRaw(JSON.stringify({ markdown: "fresh", savedAt: now }), key(USER, "fresh"));
    putRaw(JSON.stringify({ markdown: "old", savedAt: now - WEEK_MS - 1000 }), key(USER, "old"));
    putRaw(JSON.stringify({ markdown: "theirs", savedAt: now }), key(OTHER_USER, "theirs"));
    localStorage.setItem("wooble-theme", "dark");

    pruneDocumentationDrafts(USER);

    expect(Object.keys(localStorage).sort()).toEqual([key(USER, "fresh"), "wooble-theme"].sort());
  });

  it("removes malformed entries under this module's prefix and leaves other keys alone", () => {
    putRaw("not json", key(USER, "a"));
    putRaw("null", key(USER, "b"));
    putRaw(JSON.stringify({ markdown: 3, savedAt: Date.now() }), key(USER, "c"));
    putRaw(JSON.stringify({ markdown: "x", savedAt: "soon" }), key(USER, "d"));
    putRaw(JSON.stringify({ markdown: "ok", savedAt: Date.now() }), key(USER, "e"));
    localStorage.setItem("unrelated", "keep me");

    pruneDocumentationDrafts(USER);

    expect(Object.keys(localStorage).sort()).toEqual([key(USER, "e"), "unrelated"].sort());
  });

  it("does nothing without a known user", () => {
    writeDraft(USER, "entity", OBJECT, "kept");
    pruneDocumentationDrafts("");
    expect(readDraft(USER, "entity", OBJECT)?.markdown).toBe("kept");
  });

  it("never throws when the store is unavailable", () => {
    writeDraft(USER, "entity", OBJECT, "x");
    withBrokenStorage("key", { value: refusing("SecurityError") }, () => {
      expect(() => pruneDocumentationDrafts(USER)).not.toThrow();
    });
    withBrokenStorage("getItem", { value: refusing("SecurityError") }, () => {
      expect(() => pruneDocumentationDrafts(USER)).not.toThrow();
    });
    withBrokenStorage("removeItem", { value: refusing("SecurityError") }, () => {
      putRaw("garbage", key(OTHER_USER, "z"));
      expect(() => pruneDocumentationDrafts(USER)).not.toThrow();
    });
  });
});
