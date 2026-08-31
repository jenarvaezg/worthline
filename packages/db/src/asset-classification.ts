import type { ClassifiableAsset } from "@worthline/domain";

import type { assets } from "./schema";

/**
 * The columns the ADR 0014 derivation needs off an `assets` row — its instrument
 * plus the legacy pair the derivation falls back to when the instrument is NULL.
 */
type ClassifiableAssetRow = Pick<
  typeof assets.$inferSelect,
  "instrument" | "isPrimaryResidence" | "type"
>;

/**
 * A raw `assets` row seen as the domain sees it, so a store seam can ask
 * `instrumentOfAsset` / `valuationMethodOfAsset` without inflating a full
 * `ManualAsset` (#1680).
 *
 * It exists to keep the `is_primary_residence === 1` decoding in ONE place: the
 * column is an integer, and a seam that forgets the comparison silently hands the
 * derivation a truthy `0`.
 */
export function classifiableAssetFromRow(row: ClassifiableAssetRow): ClassifiableAsset {
  return {
    instrument: row.instrument,
    isPrimaryResidence: row.isPrimaryResidence === 1,
    type: row.type,
  };
}
