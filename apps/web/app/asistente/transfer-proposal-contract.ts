/**
 * Client-facing shape of a traspaso proposal (#1482) — what `propose_transfer` returns
 * and its card renders, plus the trust-boundary parser the server action re-reads on
 * confirm. Kept apart from the builder, like the operation and correction contracts, so
 * the card and the action share the draft type without pulling in the store.
 *
 * Every figure the card renders is a STRING the server already formatted: the client
 * never re-derives money, a quantity, a VL or a date.
 */

export interface TransferProposalDraft {
  proposalId: string;
}

/** One side of the pair, as the card prints it. */
export interface TransferProposalSide {
  /** The public holding id (`wl_hld_…`), echoed for the record. */
  id: string;
  name: string;
  /** «Salen de «X»: 841,262 → 804,059 participaciones». */
  positionLine: string;
  /** «37,203 part. × 19,87091 € · 739,22 €» — the half, term by term. */
  movementLine: string;
}

export interface TransferProposal {
  proposalType: "investment_transfer";
  draft: TransferProposalDraft;
  folio: string;
  /** One-line description of the movement, for the card's title. */
  summary: string;
  /**
   * What worthline READ in the user's message — the date and the portion, verbatim.
   * The ceremony of this lane lives here: the importe was parsed off the message, so
   * a misread is caught by comparing this line with what the person wrote.
   */
  dictated: string;
  origin: TransferProposalSide;
  destination: TransferProposalSide;
  /** «Coste de adquisición que viaja: 612,45 €». */
  inheritedCost: string;
  /**
   * Net worth before → after in minor units, and the change. Null on both ends when
   * the net-worth read degraded (ADR 0048); the delta never is.
   */
  impact: { beforeMinor: number | null; afterMinor: number | null; deltaMinor: number };
  impactCaption: string;
  /** What a traspaso does not do, plus any honest warning about the VLs used. */
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parseTransferProposalDraft(raw: unknown) {
  if (!isRecord(raw) || typeof raw.proposalId !== "string" || !raw.proposalId.trim()) {
    return { ok: false as const, error: "Falta la referencia de la propuesta." };
  }
  return { ok: true as const, draft: { proposalId: raw.proposalId.trim() } };
}

/** Shape check for one side of the pair — three strings, nothing derived. */
export function isTransferProposalSide(value: unknown): value is TransferProposalSide {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.positionLine === "string" &&
    typeof value.movementLine === "string"
  );
}
