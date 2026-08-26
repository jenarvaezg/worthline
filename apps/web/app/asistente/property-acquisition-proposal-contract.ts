/**
 * Client-facing shape of a property-acquisition proposal (#1563) — what
 * `propose_property_acquisition` returns and its card renders.
 *
 * Separate from the builder, like every other contract here, so the card and the
 * server action share the draft type without pulling the store into the client
 * bundle.
 *
 * Every figure arrives already rendered es-ES. The card decides nothing about
 * money or dates: what the user reads next to the Confirmar button is what the
 * store's own numbers produced, which is the same rule the early-repayment card
 * follows (#1245) and the reason its rows are strings.
 */

import type { HousingCurveComparisonPoint } from "@worthline/domain";

/** The atomic folio the card renders, sibling of {@link EARLY_REPAYMENT_FOLIO}. */
export const PROPERTY_ACQUISITION_FOLIO =
  "1 propuesta · 1 inmueble · 1 fecha de adquisición";

export interface PropertyAcquisitionProposalDraft {
  proposalId: string;
}

/** One before → after line of the pair being moved, already rendered es-ES. */
export interface PropertyAcquisitionProposalRow {
  label: string;
  before: string;
  after: string;
}

export interface PropertyAcquisitionProposal {
  proposalType: "property_acquisition";
  draft: PropertyAcquisitionProposalDraft;
  /**
   * The holding this proposal targets, echoed like every sibling contract does.
   * The card prints the `name`; the `id` is the identity echo the convention
   * keeps, and it is the public `wl_hld_…` the user could read back.
   *
   * There is deliberately NO `acquisition: { date, value }` block beside it: the
   * proposed pair is already in `rows`, next to the pair it replaces, and a
   * second copy in the stream would be a figure the card never renders and the
   * parser still has to check.
   */
  property: { id: string; name: string };
  /** The date and the price, each with the value it replaces. */
  rows: PropertyAcquisitionProposalRow[];
  /**
   * The two value curves the edit compares, from the domain preview of #1562 —
   * the same engine the ficha's ceremony draws and the ripple writes with (#1438).
   * The card draws the AFTER curve from it; the BEFORE values ride along so the
   * reader can see the stretch that moves, not just its endpoints.
   */
  points: HousingCurveComparisonPoint[];
  /** Honest warnings: what the rewrite reaches, and what it does not fix. */
  notes: string[];
  /** One-line description of the fact, for the card's title. */
  summary: string;
  folio: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parsePropertyAcquisitionProposalDraft(raw: unknown) {
  if (!isRecord(raw) || typeof raw.proposalId !== "string" || !raw.proposalId.trim()) {
    return { ok: false as const, error: "Falta la referencia de la propuesta." };
  }
  return { ok: true as const, draft: { proposalId: raw.proposalId.trim() } };
}
