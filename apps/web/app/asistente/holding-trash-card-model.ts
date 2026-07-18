/**
 * Pure interaction module for the baja/restauración card (#1106, PRD #1103 S3,
 * superficie B «encabezado por impacto», docs/interaction-patterns.md §7). The
 * React card is a thin shell; the display logic — the impact header wording and
 * the informative warning strings — lives here so it is unit-tested without
 * rendering. It fabricates nothing: when the net-worth total is unknown it says
 * so, and every warning is informative (never blocks).
 */

import type { HoldingTrashImpact } from "./holding-trash-impact";
import type { HoldingTrashProposal } from "./holding-trash-proposal-contract";

export interface HoldingTrashImpactHeader {
  /** True when both before and after net worth are known (not a degraded read). */
  totalKnown: boolean;
  /** "Patrimonio neto X → Y", or the delta-only line when the total degraded. */
  headline: string;
  /** Signed, formatted delta, e.g. "+12.500 €" / "−12.500 €". */
  deltaLabel: string;
  /** Whether the batch raises net worth (drives the ok/error tone). */
  increases: boolean;
}

/**
 * The impact header the card leads with (superficie B). Takes an injected money
 * formatter so the module stays pure (no es-ES/Intl coupling in tests).
 */
export function holdingTrashImpactHeader(
  impact: HoldingTrashImpact,
  format: (minor: number) => string,
): HoldingTrashImpactHeader {
  const increases = impact.deltaMinor >= 0;
  const deltaLabel = `${increases ? "+" : "−"}${format(Math.abs(impact.deltaMinor))}`;
  const totalKnown = impact.beforeMinor !== null && impact.afterMinor !== null;
  const headline = totalKnown
    ? `Patrimonio neto ${format(impact.beforeMinor as number)} → ${format(
        impact.afterMinor as number,
      )}`
    : `Impacto en el patrimonio: ${deltaLabel} (total no disponible ahora)`;
  return { deltaLabel, headline, increases, totalKnown };
}

/**
 * The informative warnings the card lists in oro (never blocks, #1086): a debt
 * orphaned by removing its asset, shared ownership, and — on restauración — a
 * live-holding duplicate. Order is stable: orphans, then shared ownership, then
 * duplicates.
 */
export function holdingTrashWarnings(proposal: HoldingTrashProposal): string[] {
  const messages: string[] = [];
  for (const pair of proposal.orphanPairs) {
    messages.push(
      `La deuda «${pair.debtName}» quedará sin su activo «${pair.assetName}».`,
    );
  }
  for (const line of proposal.lines) {
    if (line.sharedOwnership) {
      messages.push(`«${line.name}» es de propiedad compartida.`);
    }
  }
  for (const duplicate of proposal.duplicates) {
    const strength =
      duplicate.confidence === "strong" ? " (coincidencia fuerte)" : " (mismo nombre)";
    messages.push(
      `Al restaurar «${duplicate.name}» habrá un duplicado con «${duplicate.liveName}»${strength}.`,
    );
  }
  return messages;
}
