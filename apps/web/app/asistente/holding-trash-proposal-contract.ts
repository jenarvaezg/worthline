/**
 * Client-facing shape of a baja/restauración proposal (#1106, PRD #1103 S3) —
 * what the `propose_holding_removal` / `propose_holding_restoration` tools return
 * and the trash card renders. Kept separate from the builder so the server action
 * and the trust-boundary parser share the draft type without pulling in the store.
 *
 * The two mirror operations share one proposal shape (discriminated by
 * `proposalType` / `operation`): both lead with the net-worth impact, list the
 * batch, and carry informative-only warnings (never blocking, #1086). Baja adds
 * the orphan debt↔asset pairs; restauración adds the live-holding duplicates.
 */

import type { HoldingTrashImpact } from "./holding-trash-impact";

/** The folio the baja card states (its `assistantProposalKind` label). */
export const HOLDING_REMOVAL_FOLIO = "Propuesta de baja · A la papelera · reversible";
/** The folio the restauración card states. */
export const HOLDING_RESTORATION_FOLIO = "Propuesta de restauración · Desde la papelera";

export interface HoldingTrashProposalDraft {
  proposalId: string;
}

/** One holding in the batch, with its signed net-worth contribution. */
export interface HoldingTrashLine {
  /** Public holding id (wl_hld_…) — display keying only. */
  holdingId: string;
  name: string;
  /** es-ES instrument label (e.g. "Fondo", "Hipoteca"), or a plain fallback. */
  instrumentLabel: string;
  kind: "asset" | "liability";
  /** Formatted magnitude (value / balance), e.g. "12.500 €". */
  detail: string;
  /** Signed ownership-weighted contribution to net worth (asset +, debt −), minor units. */
  contributionMinor: number;
  /** True when the holding has more than one owner member (informative). */
  sharedOwnership: boolean;
}

/** A debt left without its associated asset by a baja (informative, #1086). */
export interface HoldingTrashOrphanPair {
  /** The debt that would remain without its asset. */
  debtName: string;
  /** The removed asset it was associated to. */
  assetName: string;
}

/** A restored holding that would duplicate a live one (informative, #1086). */
export interface HoldingTrashDuplicate {
  /** The holding being restored. */
  name: string;
  /** The live holding it looks like. */
  liveName: string;
  confidence: "strong" | "weak";
}

export interface HoldingTrashProposal {
  proposalType: "holding_removal" | "holding_restoration";
  operation: "remove" | "restore";
  draft: HoldingTrashProposalDraft;
  folio: string;
  lines: HoldingTrashLine[];
  impact: HoldingTrashImpact;
  /** Baja only: debts orphaned by removing their asset. Empty otherwise. */
  orphanPairs: HoldingTrashOrphanPair[];
  /** Restauración only: live-holding duplicates. Empty otherwise. */
  duplicates: HoldingTrashDuplicate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parseHoldingTrashProposalDraft(
  raw: unknown,
): HoldingTrashProposalDraft | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.proposalId !== "string" || raw.proposalId.length === 0) return null;
  return { proposalId: raw.proposalId };
}
