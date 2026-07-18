/**
 * Holding baja/restauración impact (#1106, PRD #1103 S3) — the pure "patrimonio
 * neto antes → después" arithmetic both trash cards lead with (superficie B,
 * #1088). No store, no clock: it takes the scope net worth before and the signed
 * contributions of the batch, and returns the before/after/delta triple.
 *
 * Each holding carries a **signed contribution** to the household net worth while
 * it is present: an asset adds its ownership-weighted value, a debt subtracts its
 * balance. Removing the holding moves net worth by the negation of that
 * contribution; restoring it moves net worth by the contribution itself — so the
 * two mirror operations share one function and only differ in sign.
 */

/** Signed contribution of ONE holding to net worth while present (asset +, debt −). */
export interface HoldingTrashContribution {
  contributionMinor: number;
}

export interface HoldingTrashImpact {
  /**
   * The scope net worth before applying the batch, or `null` when the canonical
   * read failed/degraded. `null` is NOT an empty workspace's real 0 €: an honest
   * card shows "impacto no disponible" rather than fabricate a total it never
   * read (ADR 0048).
   */
  beforeMinor: number | null;
  /** `beforeMinor + deltaMinor`, or `null` when `beforeMinor` is unknown. */
  afterMinor: number | null;
  /** Always known: the signed net-worth change the batch causes. */
  deltaMinor: number;
}

/**
 * The before/after/delta the card renders. For a **baja** the delta is the
 * negation of the batch's summed contribution (removing an asset lowers net
 * worth, removing a debt raises it); for a **restauración** it is the summed
 * contribution itself. `afterMinor = beforeMinor + deltaMinor` by construction,
 * so the card never re-derives the arithmetic. When `netWorthBeforeMinor` is
 * `null` (a failed read) only the delta is known.
 */
export function holdingTrashImpact(
  netWorthBeforeMinor: number | null,
  operation: "remove" | "restore",
  contributions: readonly HoldingTrashContribution[],
): HoldingTrashImpact {
  const summed = contributions.reduce((total, line) => total + line.contributionMinor, 0);
  const deltaMinor = operation === "remove" ? -summed : summed;
  return {
    afterMinor: netWorthBeforeMinor === null ? null : netWorthBeforeMinor + deltaMinor,
    beforeMinor: netWorthBeforeMinor,
    deltaMinor,
  };
}

/**
 * The signed contribution of a holding to the household net worth, weighted by
 * its total ownership bps. Positive for an asset, negative for a debt (`sign`),
 * rounded to whole minor units so before/after stay integer money — the same
 * weighting {@link holding-creation-impact} applies to an alta.
 */
export function signedContributionMinor(
  valueMinor: number,
  ownershipBps: number,
  sign: 1 | -1,
): number {
  return Math.round((sign * valueMinor * ownershipBps) / 10_000);
}
