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
import {
  type ProposalImpactHeader,
  proposalImpactHeader,
} from "./proposal-impact-header";

export type HoldingTrashImpactHeader = ProposalImpactHeader;

/**
 * The impact header the card leads with (superficie B) — the shared one every card
 * uses since #1374, kept under this name because it is how this card asks for it.
 */
export function holdingTrashImpactHeader(
  impact: HoldingTrashImpact,
  format: (minor: number) => string,
): HoldingTrashImpactHeader {
  return proposalImpactHeader(impact, format);
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
