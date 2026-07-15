/**
 * Client-facing shape of a correction proposal (#1051) — what the
 * `propose_correction` tool returns and the superficie C card renders. Kept
 * separate from the builder so the server action and the trust-boundary parser
 * can share the draft type without pulling in the store.
 */

import type { CorrectionGuarantee } from "./anchor-correction-gate";

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

export interface CorrectionProposal {
  proposalType: "correction";
  draft: CorrectionProposalDraft;
  holding: { id: string; name: string };
  mode: "solo-desde-hoy";
  /** One-line description of the fix, for the card's title. */
  summary: string;
  /** The guarantee block state (interaction-patterns superficie C). */
  guarantee: CorrectionGuarantee;
  edits: CorrectionProposalEditRow[];
  /** The atomic-batch folio, e.g. "1 propuesta · 1 holding · 1 lote atómico". */
  folio: string;
}

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
