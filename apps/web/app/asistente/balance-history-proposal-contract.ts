import type { DebtSnapshotMembership } from "@worthline/domain";

import type { BalanceReconciliation } from "./balance-reconciliation";

export interface BalanceHistoryProposalDraft {
  proposalId: string;
}

export interface BalanceHistoryProposal {
  proposalType: "balance_history_import";
  draft: BalanceHistoryProposalDraft;
  liability: { id: string; name: string };
  points: Array<{
    date: string;
    balanceMinor: number;
    driftMinor: number | null;
    status: "accepted" | "excluded" | "skipped";
    reason?: string;
  }>;
  curve: Array<{ date: string; balanceMinor: number }>;
  reconciliation: BalanceReconciliation;
  /**
   * How many of the dates the ripple will materialize would omit this debt
   * (#1438). Same preflight as the reconstruction card: total miss ⇒ no confirm.
   *
   * Required for the same reason as its sibling: an absent membership reads as
   * "confirm allowed" with nothing measured, so the boundary refuses the payload
   * rather than open the gate on a figure it never got.
   */
  snapshotMembership: DebtSnapshotMembership;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseBalanceHistoryProposalDraft(raw: unknown) {
  if (!isRecord(raw) || typeof raw.proposalId !== "string" || !raw.proposalId.trim()) {
    return { ok: false as const, error: "Falta la referencia de la propuesta." };
  }
  return { ok: true as const, draft: { proposalId: raw.proposalId.trim() } };
}
