/**
 * Trust boundary for an early-repayment proposal (#1245). Every rendered figure is a
 * STRING the server already formatted, so the card cannot re-derive money or dates;
 * what is checked here is that each of them is actually there.
 */

import type {
  EarlyRepaymentProposal,
  EarlyRepaymentProposalReconciliation,
} from "@web/asistente/early-repayment-proposal-contract";
import { parseEarlyRepaymentProposalDraft } from "@web/asistente/early-repayment-proposal-contract";
import type { EarlyRepaymentMode } from "@worthline/domain";
import {
  isOneOf,
  isRecord,
  parseAll,
  parseBeforeAfterRow,
  parseNamedRef,
  parseStrings,
} from "./shapes";

const MODES: readonly EarlyRepaymentMode[] = ["reduce-payment", "reduce-term"];

function parseRepayment(raw: unknown): EarlyRepaymentProposal["repayment"] | null {
  if (!isRecord(raw)) return null;
  const { amount, boundaryDate, date, dateLabel, mode, modeLabel } = raw;
  if (typeof date !== "string" || typeof dateLabel !== "string") return null;
  if (typeof boundaryDate !== "string" || typeof amount !== "string") return null;
  if (typeof modeLabel !== "string" || !isOneOf(mode, MODES)) return null;
  return { amount, boundaryDate, date, dateLabel, mode, modeLabel };
}

/** Null when the capture showed no cuota to reconcile against — a fact, not a gap. */
function parseReconciliation(raw: unknown): EarlyRepaymentProposalReconciliation | null {
  if (!isRecord(raw)) return null;
  const { matches, observed, plan } = raw;
  if (typeof observed !== "string" || typeof plan !== "string") return null;
  if (typeof matches !== "boolean") return null;
  return { matches, observed, plan };
}

export function parseEarlyRepaymentProposal(raw: unknown): EarlyRepaymentProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "early_repayment") return null;
  const draft = parseEarlyRepaymentProposalDraft(raw.draft);
  const holding = parseNamedRef(raw.holding);
  const repayment = parseRepayment(raw.repayment);
  const rows = parseAll(raw.rows, parseBeforeAfterRow);
  const notes = parseStrings(raw.notes);
  const { folio, summary } = raw;
  if (!draft.ok || holding === null || repayment === null) return null;
  if (rows === null || notes === null) return null;
  if (typeof summary !== "string" || typeof folio !== "string") return null;
  const reconciliation =
    raw.reconciliation === null ? null : parseReconciliation(raw.reconciliation);
  if (reconciliation === null && raw.reconciliation !== null) return null;
  return {
    draft: draft.draft,
    folio,
    holding,
    notes,
    proposalType: "early_repayment",
    reconciliation,
    repayment,
    rows,
    summary,
  };
}
