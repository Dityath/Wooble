import type { ComponentType } from "react";
import type { RichDocumentationProps } from "../rich-documentation-editor";

export type EditorModule = { default: ComponentType<RichDocumentationProps> };
export type EditorLoader = () => Promise<EditorModule>;

/** Loads the editor chunk. Kept apart from the components so tests can replace it with a failing import. */
export const loadEditor: EditorLoader = () =>
  import("../rich-documentation-editor").then((module) => ({ default: module.RichDocumentation }));
