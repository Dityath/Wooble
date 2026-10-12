import { describe, expect, it } from "bun:test";
import {
  clearDocumentationDrafts,
  documentationDraftKey,
  keepDocumentationDraft,
  readDocumentationDraft,
  removeDocumentationDraft,
} from "../src/features/inspector/documentation/drafts";

const draft = { markdown: "Notes v2", base: "Notes", keptAt: "2026-10-12T09:30:00.000Z" };

describe("documentation drafts", () => {
  it("keys drafts by user, object kind, and object", () => {
    const keys = [
      documentationDraftKey("user-ada", "entity", "id-1"),
      documentationDraftKey("user-grace", "entity", "id-1"),
      documentationDraftKey("user-ada", "connection", "id-1"),
      documentationDraftKey("user-ada", "entity", "id-2"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps, reads, and removes a draft", () => {
    const key = documentationDraftKey("user-ada", "entity", "id-1");
    expect(readDocumentationDraft(key)).toBeUndefined();
    expect(keepDocumentationDraft(key, draft)).toBe(true);
    expect(readDocumentationDraft(key)).toEqual(draft);
    removeDocumentationDraft(key);
    expect(readDocumentationDraft(key)).toBeUndefined();
  });

  it("ignores stored values that are not drafts", () => {
    const key = documentationDraftKey("user-ada", "entity", "id-1");
    for (const value of ["not JSON", "null", "42", JSON.stringify({ markdown: "Notes" }), JSON.stringify([draft])]) {
      localStorage.setItem(key, value);
      expect(readDocumentationDraft(key)).toBeUndefined();
    }
  });

  const fail = (message: string) => () => {
    throw new Error(message);
  };
  const brokenStorage: Array<[string, PropertyDescriptor]> = [
    // Browsers that block site data throw on any use of localStorage, including reading the property.
    ["blocks storage", { get: fail("Access is denied for this document.") }],
    [
      "has full or failing storage",
      {
        value: {
          length: 1,
          getItem: fail("Storage failed"),
          setItem: fail("The quota has been exceeded."),
          removeItem: fail("Storage failed"),
          key: fail("Storage failed"),
        },
      },
    ],
  ];
  for (const [browser, storage] of brokenStorage) {
    it(`treats a browser that ${browser} as holding no drafts`, () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      Object.defineProperty(globalThis, "localStorage", { configurable: true, ...storage });
      try {
        const key = documentationDraftKey("user-ada", "entity", "id-1");
        expect(keepDocumentationDraft(key, draft)).toBe(false);
        expect(readDocumentationDraft(key)).toBeUndefined();
        expect(() => removeDocumentationDraft(key)).not.toThrow();
        expect(() => clearDocumentationDrafts()).not.toThrow();
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    });
  }

  it("clears every account's drafts and nothing else", () => {
    keepDocumentationDraft(documentationDraftKey("user-ada", "entity", "id-1"), draft);
    keepDocumentationDraft(documentationDraftKey("user-grace", "connection", "id-2"), draft);
    localStorage.setItem("wooble-theme", "dark");
    clearDocumentationDrafts();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("wooble-theme")).toBe("dark");
  });
});
