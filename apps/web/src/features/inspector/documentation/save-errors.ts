import { ApiError } from "../../../lib/api";

/**
 * How a failed documentation save should be handled:
 * - `forbidden`: write access is gone for good, so the editor becomes read-only and the draft is dropped.
 * - `invalid`: the server rejected this content; saving the same content again cannot succeed.
 * - `session`: the session ended; saving needs a new sign-in, and the draft is kept for it.
 * - `transient`: a network or server failure that a retry may fix.
 */
export type SaveFailureKind = "forbidden" | "invalid" | "session" | "transient";

export interface SaveFailure {
  kind: SaveFailureKind;
  message: string;
}

export const FORBIDDEN_MESSAGE =
  "You can no longer edit this documentation. Your access to it has changed, so your unsaved changes were not saved.";
export const SESSION_ENDED_MESSAGE = "Your session has ended. Sign in again to save.";

export function classifySaveError(cause: unknown): SaveFailure {
  const message = cause instanceof Error && cause.message ? cause.message : "Could not save documentation";
  if (cause instanceof ApiError) {
    if (cause.status === 403) return { kind: "forbidden", message: FORBIDDEN_MESSAGE };
    if (cause.status === 401) return { kind: "session", message: SESSION_ENDED_MESSAGE };
    if (cause.status === 400 || cause.status === 422) return { kind: "invalid", message };
  }
  return { kind: "transient", message };
}

/** The notice for documentation over the server's limit, such as "Remove 1,234 characters to save." */
export function tooLongMessage(excess: number): string {
  return `Documentation is limited to 20,000 characters of Markdown. Remove ${excess.toLocaleString("en-US")} ${
    excess === 1 ? "character" : "characters"
  } to save.`;
}
