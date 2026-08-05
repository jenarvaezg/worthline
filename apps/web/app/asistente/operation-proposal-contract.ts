/**
 * Client-facing shape of an operation proposal (#1374) — what `propose_operation`
 * returns and its card renders, plus the trust-boundary parser the server action
 * re-reads on confirm. Kept separate from the builder so the card and the action
 * share the draft type without pulling in the store, exactly like the correction and
 * early-repayment contracts.
 *
 * Every figure the card renders is a STRING the server already formatted: the client
 * never re-derives money, a quantity or a date.
 */

import type { OperationKindClaim } from "./operation-document-frontier";

export interface OperationProposalDraft {
  proposalId: string;
}

export interface OperationProposal {
  proposalType: "investment_operation";
  draft: OperationProposalDraft;
  folio: string;
  /** One-line description of the fact, for the card's title. */
  summary: string;
  /** What the document literally says — printed apart from the destination. */
  document: { line: string; fact: string };
  /** Where the operation lands, by NAME (an id is machinery, #1263). */
  holding: { id: string; name: string; destination: string };
  /** The position's participaciones before → after, es-ES. */
  position: { unitsBefore: string; unitsAfter: string };
  /**
   * Net worth before → after in minor units, and the change. `beforeMinor` and
   * `afterMinor` are null when the net-worth read degraded (ADR 0048): the card then
   * shows the delta and says the total is unavailable, rather than fabricate one.
   */
  impact: { beforeMinor: number | null; afterMinor: number | null; deltaMinor: number };
  /** The es-ES caption that qualifies the impact as an estimate. */
  impactCaption: string;
  /** Honest warnings (derived participaciones, printed terms that do not add up…). */
  notes: string[];
  kind: OperationKindClaim;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parseOperationProposalDraft(raw: unknown) {
  if (!isRecord(raw) || typeof raw.proposalId !== "string" || !raw.proposalId.trim()) {
    return { ok: false as const, error: "Falta la referencia de la propuesta." };
  }
  return { ok: true as const, draft: { proposalId: raw.proposalId.trim() } };
}
