/**
 * The impact header every superficie-B proposal card leads with (#1088): «Patrimonio
 * neto X → Y», the signed delta, and the honest degraded form when the net-worth read
 * did not answer (ADR 0048).
 *
 * It lived in `holding-trash-card-model.ts`, named for the baja card, and three other
 * cards re-derived the same four lines inline — each with its own
 * `impact.beforeMinor as number` cast, which is the tell: a cast repeated four times is
 * a narrowing the code wanted to do once. #1374 would have made it five, so it moved
 * here instead. The baja's own function stays as its named entry point.
 *
 * Pure and I/O-free, with the money formatter injected so no `Intl` coupling reaches
 * the tests (`docs/interaction-patterns.md` §7, ADR 0036).
 */

/** Before/after net worth in minor units, nullable when the read degraded. */
export interface ProposalImpact {
  beforeMinor: number | null;
  afterMinor: number | null;
  deltaMinor: number;
}

export interface ProposalImpactHeader {
  /** True when both before and after net worth are known (not a degraded read). */
  totalKnown: boolean;
  /** "Patrimonio neto X → Y", or the delta-only line when the total degraded. */
  headline: string;
  /** Signed, formatted delta, e.g. "+12.500 €" / "−12.500 €", plus any caption. */
  deltaLabel: string;
  /** Whether the change raises net worth (drives the ok/error tone). */
  increases: boolean;
}

export interface ProposalImpactHeaderOptions {
  /**
   * A qualifier the delta carries, appended after «·» — «estimado sobre los
   * movimientos» (#1373), «estimado sobre la operación» (#1374). It rides on the
   * delta and not on the headline because it qualifies the CHANGE, which is the
   * figure a ripple can still move; the totals are read, not estimated.
   */
  caption?: string;
}

export function proposalImpactHeader(
  impact: ProposalImpact,
  format: (minor: number) => string,
  options: ProposalImpactHeaderOptions = {},
): ProposalImpactHeader {
  const { afterMinor, beforeMinor, deltaMinor } = impact;
  const increases = deltaMinor >= 0;
  const caption = options.caption ? ` · ${options.caption}` : "";
  const deltaLabel = `${increases ? "+" : "−"}${format(Math.abs(deltaMinor))}${caption}`;
  // A null total means the net-worth read degraded: show the known delta, never
  // fabricate a total the card never read (ADR 0048).
  const totalKnown = beforeMinor !== null && afterMinor !== null;
  const headline =
    beforeMinor !== null && afterMinor !== null
      ? `Patrimonio neto ${format(beforeMinor)} → ${format(afterMinor)}`
      : `Impacto en el patrimonio: ${deltaLabel} (total no disponible ahora)`;
  return { deltaLabel, headline, increases, totalKnown };
}
