/**
 * Client-facing shape of a holding-creation proposal (#1105, PRD #1103 S2) — what
 * the `propose_holding` tool returns and the alta card renders. Kept separate from
 * the builder so the server action and the trust-boundary parser can share the
 * draft type without pulling in the store.
 */

import type { HoldingCreationFamily } from "@worthline/db";
import type { HoldingCreationImpact } from "./holding-creation-impact";

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
