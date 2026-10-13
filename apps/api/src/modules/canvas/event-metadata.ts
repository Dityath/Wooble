/**
 * Shared shapes for canvas event metadata that the undo engine reads.
 * Writers (entity and connection PATCH routes) build these; `undo.ts` consumes them.
 */

/** State of one metadata key before an update. `present: false` means the key did not exist. */
export type PreviousMetadataEntry = { present: false } | { present: true; value: unknown };

/**
 * Version 2 metadata for `entity.updated` and `connection.updated` (non-bend).
 * Undo restores only what is listed here and leaves all other fields and
 * metadata keys at their current values.
 */
export interface UpdateEventMetadataV2 {
  version: 2;
  /** Keys of the request body; may include "metadata". */
  fields: string[];
  /**
   * Previous values of only the top-level fields named in the body, excluding
   * "metadata". Entity: type | name | description. Connection: type | label | description.
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

/** True when the stored event metadata uses the version 2 update format. */
export function isUpdateEventMetadataV2(
  metadata: Record<string, unknown>,
): metadata is Record<string, unknown> & UpdateEventMetadataV2 {
  return metadata.version === 2;
}
