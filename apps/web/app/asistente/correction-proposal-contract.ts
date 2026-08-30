/**
 * Client-facing shape of a correction proposal (#1051) — what the
 * `propose_correction` tool returns and the superficie C card renders. Kept
 * separate from the builder so the server action and the trust-boundary parser
 * can share the draft type without pulling in the store.
 */

import type { DebtSnapshotMembership } from "@worthline/domain";

import type { CorrectionGuarantee, CorrectionPoint } from "./anchor-correction-gate";
import type { BalanceReconciliation } from "./balance-reconciliation";

/** The atomic-batch folio both correction depths render (#1051/#1053). */
export const CORRECTION_FOLIO = "1 propuesta · 1 holding · 1 lote atómico";

export interface CorrectionProposalEditRow {
  /** Human label of what changes (e.g. "Saldo pendiente"). */
  label: string;
  /** es-ES rendering of the value being replaced (or "—" when none). */
  before: string;
  /** es-ES rendering of the declared value. */
  after: string;
  /** Whether the assistant extracted this or you corrected it. */
  origin: "assistant" | "user";
}

/**
 * One point of the reconstruct-depth series (#1053): the gate's `CorrectionPoint`
 * plus display-only fields the folded detail shows (drift vs the modelled curve,
 * and the exclusion reason for an unusable extracted row).
 */
export interface CorrectionSeriesPoint extends CorrectionPoint {
  driftMinor?: number | null;
  reason?: string;
}

interface CorrectionProposalBase {
  proposalType: "correction";
  draft: CorrectionProposalDraft;
  holding: { id: string; name: string };
  /** One-line description of the fix, for the card's title. */
  summary: string;
  /** The guarantee block state (interaction-patterns superficie C). */
  guarantee: CorrectionGuarantee;
  /** The atomic-batch folio, e.g. "1 propuesta · 1 holding · 1 lote atómico". */
  folio: string;
}

/** "Solo desde hoy" depth (#1051): a small diff of declared facts. */
export interface AnchorOnlyCorrectionProposal extends CorrectionProposalBase {
  mode: "solo-desde-hoy";
  edits: CorrectionProposalEditRow[];
}

/**
 * "Reconstruir historia" depth (#1053): the reconstructed dated balance series,
 * an orienting stepped curve and the reconciliation. Confirmar no longer hangs on
 * the reconciliation (#1422): a mismatch is confirmable, saying what it will do —
 * the verdict and its tolerance live in the pure `balance-reconciliation` module.
 */
export interface ReconstructionCorrectionProposal extends CorrectionProposalBase {
  mode: "reconstruir";
  series: CorrectionSeriesPoint[];
  curve: Array<{ date: string; balanceMinor: number }>;
  /** The present-day balance the reconstruction was measured against. */
  anchorMinor: number;
  /** The full three-witness verdict the card renders (#1422). */
  reconciliation: BalanceReconciliation;
  /**
   * How many of the dates the ripple will materialize would omit this debt
   * (#1438). `missing === total` turns Confirmar off; a partial miss warns.
   *
   * Optional because a payload built before the preflight existed simply has no
   * membership to state, and the card already reads it that way: no membership
   * warns about nothing and blocks nothing. Every builder sets it.
   */
  snapshotMembership?: DebtSnapshotMembership;
}

export type CorrectionProposal =
  | AnchorOnlyCorrectionProposal
  | ReconstructionCorrectionProposal;

export interface CorrectionProposalDraft {
  proposalId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parseCorrectionProposalDraft(
  raw: unknown,
): CorrectionProposalDraft | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.proposalId !== "string" || raw.proposalId.length === 0) return null;
  return { proposalId: raw.proposalId };
}
