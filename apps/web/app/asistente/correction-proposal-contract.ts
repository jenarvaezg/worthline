/**
 * Client-facing shape of a correction proposal (#1051) — what the
 * `propose_correction` tool returns and the superficie C card renders. Kept
 * separate from the builder so the server action and the trust-boundary parser
 * can share the draft type without pulling in the store.
 */

import type { CorrectionGuarantee, CorrectionPoint } from "./anchor-correction-gate";

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
 * an orienting stepped curve and the reconciliation anchor. Confirmar unlocks
 * only when the endpoint reconciles to the anchor (gate lives in the pure module).
 */
export interface ReconstructionCorrectionProposal extends CorrectionProposalBase {
  mode: "reconstruir";
  series: CorrectionSeriesPoint[];
  curve: Array<{ date: string; balanceMinor: number }>;
  /** The present-day balance the reconstruction must reproduce. */
  anchorMinor: number;
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
