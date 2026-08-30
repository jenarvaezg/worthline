/**
 * Trust boundary for a balance-history import proposal (#1348): the dated points a
 * document declared, the curve they redraw, and the verdict (#1422) the card prints.
 */

import type { BalanceHistoryProposal } from "@web/asistente/balance-history-proposal-contract";
import { parseBalanceHistoryProposalDraft } from "@web/asistente/balance-history-proposal-contract";
import {
  isNullableNumber,
  isRecord,
  parseAll,
  parseBalanceCurvePoint,
  parseBalanceReconciliation,
  parseDebtHistoryPoint,
  parseNamedRef,
  parseSnapshotMembership,
} from "./shapes";

export function parseBalanceHistoryProposal(raw: unknown): BalanceHistoryProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "balance_history_import") return null;
  const draft = parseBalanceHistoryProposalDraft(raw.draft);
  const liability = parseNamedRef(raw.liability);
  const points = parseAll(raw.points, parseDebtHistoryPoint);
  const curve = parseAll(raw.curve, parseBalanceCurvePoint);
  const reconciliation = parseBalanceReconciliation(raw.reconciliation);
  const membership = parseSnapshotMembership(raw.snapshotMembership);
  if (!draft.ok || liability === null || points === null) return null;
  if (curve === null || reconciliation === null || membership === null) return null;
  return {
    curve,
    draft: draft.draft,
    liability,
    points,
    proposalType: "balance_history_import",
    reconciliation,
    snapshotMembership: membership,
  };
}
