import type { ClassifiableAsset, Instrument } from "@worthline/domain";
import { instrumentOfAsset } from "@worthline/domain";

import { assets } from "./schema";

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

/**
 * The three columns {@link classifiableAssetFromRow} needs, to spread into a
 * `select` — so a reader that wants the derived instrument asks for the whole
 * triple or none of it. Selecting two of the three compiles and derives the wrong
 * answer for a primary residence.
 */
export const CLASSIFIABLE_ASSET_COLUMNS = {
  instrument: assets.instrument,
  isPrimaryResidence: assets.isPrimaryResidence,
  type: assets.type,
} as const;

/** The instrument an `assets` row derives to (ADR 0014, #1680) — never null. */
export function instrumentOfRow(row: ClassifiableAssetRow): Instrument {
  return instrumentOfAsset(classifiableAssetFromRow(row));
}
