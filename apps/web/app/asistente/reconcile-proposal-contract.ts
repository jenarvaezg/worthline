/**
 * Client-facing shape of a reconcile proposal (#1108, PRD #1103 S5) — what the
 * `propose_reconcile` tool returns and the reconcile card renders, plus the trust-
 * boundary parsers the server action re-reads on confirm. Kept separate from the
 * builder so the card and the action share the draft/curation types without pulling
 * in the store. The card holds the {@link ReconcileRow}s as editable client state
 * and, on confirm, sends back the per-row {@link ReconcileCuration} it curated.
 */

import type { ReconcileDecision, ReconcileRow } from "./reconcile-plan";

/** The folio the reconcile card states (superficie B, #1088). */
export function reconcileFolio(activeCount: number): string {
  return `Propuesta de reconcile · ${activeCount} holdings`;
}

export interface ReconcileProposalDraft {
  proposalId: string;
}

export interface ReconcileProposal {
  proposalType: "reconcile";
  draft: ReconcileProposalDraft;
  /** The scope net worth before the reconcile, or `null` when the read degraded. */
  netWorthBeforeMinor: number | null;
  /** The initial per-row decisions from the server-side matcher run. */
  rows: ReconcileRow[];
}

/**
 * One row's curated final decision, the editable state the card sends to confirm.
 * `target` is the holding id an `update` writes to; absent for `create` / `leave`.
 * The confirm re-resolves it against the persisted document and the live portfolio,
 * so a drift between draft and confirm is caught, never silently applied.
 */
export interface ReconcileCuration {
  rowId: string;
  decision: ReconcileDecision;
  target?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-parse a persisted draft handle from a server-action argument. */
export function parseReconcileProposalDraft(raw: unknown): ReconcileProposalDraft | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.proposalId !== "string" || raw.proposalId.length === 0) return null;
  return { proposalId: raw.proposalId };
}

const DECISIONS: ReadonlySet<string> = new Set(["create", "update", "leave"]);
const MAX_CURATION_ROWS = 1000;

/**
 * Parse the curated rows a confirm carries. Untrusted (it crosses the server-action
 * boundary): every entry must name a known-shaped decision, an `update` must carry a
 * string target, and the count is capped. A malformed payload yields `null` so the
 * action fails honestly rather than apply a half-understood batch.
 */
export function parseReconcileCuration(raw: unknown): ReconcileCuration[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CURATION_ROWS) return null;
  const curation: ReconcileCuration[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const { rowId, decision, target } = entry;
    if (typeof rowId !== "string" || rowId.length === 0 || rowId.length > 64) return null;
    if (seen.has(rowId)) return null;
    seen.add(rowId);
    if (typeof decision !== "string" || !DECISIONS.has(decision)) return null;
    if (decision === "update") {
      if (typeof target !== "string" || target.length === 0) return null;
      curation.push({ decision, rowId, target });
    } else {
      curation.push({ decision: decision as ReconcileDecision, rowId });
    }
  }
  return curation;
}
