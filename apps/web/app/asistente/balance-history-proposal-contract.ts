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
  reconciliation: { expectedMinor: number; resultingMinor: number; matches: boolean };
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
