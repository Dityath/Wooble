/**
 * Shared shapes for canvas event metadata that the undo engine reads.
 * Writers (entity and connection PATCH routes) build these; `undo.ts` consumes them.
 */

/** State of one metadata key before an update. `present: false` means the key did not exist. */
export type PreviousMetadataEntry = { present: false } | { present: true; value: unknown };

/** Format version written by the entity and connection PATCH routes. */
export const UPDATE_EVENT_METADATA_VERSION = 2;

/**
 * Version 2 metadata for `entity.updated` and `connection.updated` (non-bend).
 * Undo restores only what is listed here and leaves all other fields and
 * metadata keys at their current values.
 */
export interface UpdateEventMetadataV2 {
  version: typeof UPDATE_EVENT_METADATA_VERSION;
  /** Keys of the request body; may include "metadata". */
  fields: string[];
  /**
   * Previous values of only the top-level fields named in the body, excluding
   * "metadata". Entity: type | name | description. Connection: type | label | description.
   * A key that is missing here means that field was not touched by the update.
   */
  previous: Record<string, unknown>;
  /** Previous state of only the metadata keys named in `body.metadata`. */
  previousMetadata: Record<string, PreviousMetadataEntry>;
}

/**
 * Records, for each requested key, whether it existed in `before` and its value.
 * An existing key holding `null` is recorded as present with value null, which
 * is distinct from an absent key.
 */
export function previousMetadataEntries(
  before: Record<string, unknown>,
  keys: string[],
): Record<string, PreviousMetadataEntry> {
  const entries: Record<string, PreviousMetadataEntry> = {};
  for (const key of keys) {
    entries[key] = Object.hasOwn(before, key) ? { present: true, value: before[key] } : { present: false };
  }
  return entries;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isPreviousMetadataEntry(value: unknown): value is PreviousMetadataEntry {
  if (!isRecord(value)) return false;
  if (value.present === false) return true;
  return value.present === true && Object.hasOwn(value, "value");
}

/** True when the stored event metadata has the complete version 2 update shape. */
export function isUpdateEventMetadataV2(
  metadata: Record<string, unknown>,
): metadata is Record<string, unknown> & UpdateEventMetadataV2 {
  return (
    metadata.version === UPDATE_EVENT_METADATA_VERSION &&
    Array.isArray(metadata.fields) &&
    metadata.fields.every((field) => typeof field === "string") &&
    isRecord(metadata.previous) &&
    isRecord(metadata.previousMetadata) &&
    Object.values(metadata.previousMetadata).every(isPreviousMetadataEntry)
  );
}
