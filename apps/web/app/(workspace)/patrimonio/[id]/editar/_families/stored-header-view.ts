/**
 * The words of a stored holding's state header (#1846): how fresh its hand-set value
 * is, and when its money can be touched.
 *
 * Pure (interaction-patterns §7): the family reads the rows and renders; the rules —
 * when «hace N días» turns into the aviso's own sentence, when an undeclared term
 * says so — are tested here.
 */

import type { ManualAsset, ManualValueFreshness } from "@worthline/domain";
import {
  formatDateKeyEs,
  LIQUIDITY_TIER_LABELS,
  STALE_MANUAL_VALUE_THRESHOLD_DAYS,
} from "@worthline/domain";

/**
 * Under «Puesto al día»: how long ago, or — once the `STALE_MANUAL_VALUE` aviso
 * fires on the same reading — the aviso's own words, so the two never disagree.
 */
export function freshnessCaption(freshness: ManualValueFreshness): string {
  if (freshness.stale) {
    return `lleva más de ${STALE_MANUAL_VALUE_THRESHOLD_DAYS} días sin actualizarse`;
  }
  if (freshness.daysSince <= 0) return "hoy";
  return freshness.daysSince === 1 ? "hace 1 día" : `hace ${freshness.daysSince} días`;
}

/** «Disponibilidad»: the rung, and for a term-locked one, what its term says. */
export type AvailabilityReading =
  /** A rung with no term to declare: its label is all there is. */
  | { kind: "rung"; label: string }
  /** Term-locked with its date: «desde DD/MM/AAAA». */
  | { kind: "since"; label: string; since: string }
  /** Term-locked with no date: the gap said out loud (ADR 0100), with its door. */
  | { kind: "undeclared"; label: string }
  /** Term-locked by contribution lots (#1676), which rule over the single date. */
  | { kind: "lots"; label: string };

export function availabilityReading(
  asset: Pick<ManualAsset, "availableFrom" | "contributionLots" | "liquidityTier">,
): AvailabilityReading {
  const label = LIQUIDITY_TIER_LABELS[asset.liquidityTier];
  // Only the term-locked rung reads a term; on any other a date is inert (ADR 0100).
  if (asset.liquidityTier !== "term-locked") return { kind: "rung", label };
  if ((asset.contributionLots?.length ?? 0) > 0) return { kind: "lots", label };
  return asset.availableFrom
    ? { kind: "since", label, since: formatDateKeyEs(asset.availableFrom) }
    : { kind: "undeclared", label };
}
