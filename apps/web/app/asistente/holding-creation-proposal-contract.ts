/**
 * Client-facing shape of a holding-creation proposal (#1105, PRD #1103 S2) — what
 * the `propose_holding` tool returns and the alta card renders. Kept separate from
 * the builder so the server action and the trust-boundary parser can share the
 * draft type without pulling in the store.
 */

import type { HoldingCreationFamily } from "@worthline/db";
import type { HoldingCreationImpact } from "./holding-creation-impact";
import type { OpeningCardBreakdown } from "./holding-creation-opening";

/** The folio the alta card states (its `assistantProposalKind` label). */
export const HOLDING_CREATION_FOLIO = "Propuesta de alta · Por estado actual";

export interface HoldingCreationProposalDraft {
  proposalId: string;
}

/**
 * The informative duplicate warning (never blocks): a current holding that looks
 * like the one being created, derived by running the alta row through the S1
 * matcher's `reassignToNew` and reading `possibleDuplicate` (#1090).
 */
export interface HoldingCreationDuplicate {
  name: string;
  confidence: "strong" | "weak";
}

export interface HoldingCreationProposal {
  proposalType: "holding_creation";
  draft: HoldingCreationProposalDraft;
  folio: string;
  family: HoldingCreationFamily;
  holding: {
    name: string;
    /** es-ES instrument label (e.g. "Fondo", "Hipoteca"). */
    instrumentLabel: string;
    /** Formatted current value / balance detail (e.g. "12.500 €"). */
    detail: string;
    /**
     * The opening BUY broken down for confirmation (#1315): the títulos and unit
     * price that will be persisted, plus the commission when the document stated
     * one. Present for an investment alta with an opening — derived units
     * included, so a suspicious 3,018148 is visible BEFORE confirming.
     */
    opening?: OpeningCardBreakdown;
    /**
     * The resolved price symbol for an investment alta (#1186), surfaced so the
     * user confirms/corrects it before applying. Absent for non-investment
     * families and for an investment created without a resolved symbol.
     */
    providerSymbol?: string;
  };
  impact: HoldingCreationImpact;
  duplicate?: HoldingCreationDuplicate;
  /**
   * Informative price-tracking warning (never blocks, #1186): set when an
   * investment alta lacks a `providerSymbol`, so its value will not be repriced
   * by the daily capture / stale-price refresh until a symbol is assigned.
   */
  priceTrackingWarning?: string;
  /**
   * Informative opening-coherence warning (never blocks, #1315): set when the
   * declared cash amount and `títulos × precio + comisión` disagree by more than a
   * cent of rounding. The alta still applies with the declared terms — the figures
   * are the user's, and a document that does not add up is a fact about the
   * document (same reading as `propose_early_repayment`'s cuota reconciliation).
   */
  openingMismatchWarning?: string;
  /**
   * Where the units came from when they were minted from a live quote (#1329):
   * the delivering source and the as-of date IT states. A Yahoo close can be days
   * old, so «10 uds.» without provenance overstates what the app actually knows.
   * Absent whenever the títulos came from the document itself.
   */
  openingQuoteNote?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parseHoldingCreationProposalDraft(
  raw: unknown,
): HoldingCreationProposalDraft | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.proposalId !== "string" || raw.proposalId.length === 0) return null;
  return { proposalId: raw.proposalId };
}
