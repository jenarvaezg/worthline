/**
 * Client-facing shape of an early-repayment proposal (#1245) — what
 * `propose_early_repayment` returns and its card renders. Kept separate from the
 * builder so the server action and the trust-boundary parser share the draft type
 * without pulling in the store, exactly like the correction contract.
 */

import type { EarlyRepaymentMode } from "@worthline/domain";

/** The atomic folio the card renders, sibling of {@link CORRECTION_FOLIO}. */
export const EARLY_REPAYMENT_FOLIO = "1 propuesta · 1 deuda · 1 hecho fechado";

export interface EarlyRepaymentProposalDraft {
  proposalId: string;
}

/** One before → after line of the impact table, already rendered es-ES. */
export interface EarlyRepaymentProposalRow {
  label: string;
  before: string;
  after: string;
}

export interface EarlyRepaymentProposalReconciliation {
  /** The cuota read off the capture, es-ES. */
  observed: string;
  /** The cuota the plan derives after the repayment, es-ES. */
  plan: string;
  matches: boolean;
}

export interface EarlyRepaymentProposal {
  proposalType: "early_repayment";
  draft: EarlyRepaymentProposalDraft;
  holding: { id: string; name: string };
  /** One-line description of the fact, for the card's title. */
  summary: string;
  repayment: {
    /** The date the user paid, YYYY-MM-DD. */
    date: string;
    /** The same date rendered DD/MM/YYYY: the card never shows a raw ISO date. */
    dateLabel: string;
    /**
     * The cuota boundary the domain reshapes the plan from, YYYY-MM-DD (#182). The
     * balance itself drops on `date` (#1291); this is where the recomputed cuota /
     * shortened term is derived.
     */
    boundaryDate: string;
    /** Rendered with cents: a repayment is exact to the cent. */
    amount: string;
    mode: EarlyRepaymentMode;
    /** es-ES label of the mode, so the user confirms the reshaping explicitly. */
    modeLabel: string;
  };
  /** Balance before/after, resulting cuota, resulting end date. */
  rows: EarlyRepaymentProposalRow[];
  /** Null when the capture showed no cuota to reconcile against. */
  reconciliation: EarlyRepaymentProposalReconciliation | null;
  /** Honest warnings (month boundary, total repayment, stacked lumps…). */
  notes: string[];
  folio: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parseEarlyRepaymentProposalDraft(raw: unknown) {
  if (!isRecord(raw) || typeof raw.proposalId !== "string" || !raw.proposalId.trim()) {
    return { ok: false as const, error: "Falta la referencia de la propuesta." };
  }
  return { ok: true as const, draft: { proposalId: raw.proposalId.trim() } };
}

/** es-ES label of the reshaping the user is confirming. */
export function earlyRepaymentModeLabel(mode: EarlyRepaymentMode): string {
  return mode === "reduce-term"
    ? "acortar el plazo (misma cuota, acaba antes)"
    : "reducir la cuota (mismo plazo, cuota más baja)";
}
