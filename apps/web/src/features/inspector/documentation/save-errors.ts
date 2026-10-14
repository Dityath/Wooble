import { ApiError } from "../../../lib/api";

/**
 * How a failed documentation save should be handled:
 * - `forbidden`: write access is gone for good, so the editor becomes read-only and the draft is dropped.
 * - `permanent`: the server rejected this content or object; saving the same content again cannot succeed. The draft is
 *   kept and the text can be edited and saved again.
 * - `session`: the session ended; saving needs a new sign-in. The draft is kept, and the user chooses when to retry.
 * - `transient`: a network or server failure (including 408, 429 and 5xx) that a retry may fix.
 */
export type SaveFailureKind = "forbidden" | "permanent" | "session" | "transient";

export interface SaveFailure {
  kind: SaveFailureKind;
  message: string;
}

export const FORBIDDEN_MESSAGE =
  "You can no longer edit this documentation, so your changes were not saved. Copy anything you need and ask a canvas manager for edit access.";
export const SESSION_ENDED_MESSAGE =
  "Your session has ended. Sign in again, then choose Retry. Your text is kept on this device.";
/** A constant sentence, so a live region announcing it does not repeat on every keystroke. */
export const OVER_LIMIT_MESSAGE = "Documentation is over the 20,000-character limit.";

const rejectedMessage = (detail: string) =>
  `The server rejected this documentation: ${detail.replace(/[.\s]+$/, "")}. Edit it and try again.`;

export function classifySaveError(cause: unknown): SaveFailure {
  const message = cause instanceof Error && cause.message ? cause.message : "Could not save documentation";
  if (!(cause instanceof ApiError)) return { kind: "transient", message };
  const { status } = cause;
  if (status === 403) return { kind: "forbidden", message: FORBIDDEN_MESSAGE };
  if (status === 401) return { kind: "session", message: SESSION_ENDED_MESSAGE };
  if (status === 404 || status === 410)
    return {
      kind: "permanent",
      message: "This item no longer exists, so the documentation could not be saved. Your text is kept on this device.",
    };
  if (status === 409)
    return {
      kind: "permanent",
      message:
        "The documentation conflicts with a newer change, so it could not be saved. Your text is kept on this device.",
    };
  if (status === 413)
    return {
      kind: "permanent",
      message: "The documentation is too large for the server to accept. Shorten it and try again.",
    };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { kind: "permanent", message: rejectedMessage(message) };
  return { kind: "transient", message };
}

/** The exact excess, kept out of live regions because it changes with every keystroke. */
export function removeCharactersMessage(excess: number): string {
  return `Remove ${excess.toLocaleString("en-US")} ${excess === 1 ? "character" : "characters"} to save.`;
}
