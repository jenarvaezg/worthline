/**
 * Reconstruction correction builder (#1053, PRD #1048 S5). The "Reconstruir
 * historia" depth of the correction proposal: a document-driven dated balance
 * series (extracted from a debt statement or amortization schedule, now also from
 * a PDF via S4) is reconstructed as a chain of re-baselines (ADR 0056) and
 * reconciled to the live anchor. It persists a `correction` proposal carrying the
 * RAW observed series + before-values; it writes no financial fact — the confirm
 * re-projects the (possibly point-edited) series and applies it as ONE atomic
 * batch. Presented on the SAME superficie C as the anchor-only depth (#1051).
 *
 * The reconstruction MATH is the proven `projectBalanceHistoryProposal` seam
 * (#696/#983); this module only reshapes it into a superficie-C correction card
 * and persists the reconstruct plan under the correction proposal kind.
 */

import { createHash } from "node:crypto";
import { parseBalanceHistoryRows } from "@web/patrimonio/import-balance-history";
import type { AssistantProposalStore, WorthlineStore } from "@worthline/db";
import type { CorrectionGuarantee } from "./anchor-correction-gate";
import { projectBalanceHistoryProposal } from "./balance-history-proposals";
import {
  CORRECTION_FOLIO,
  type CorrectionSeriesPoint,
  type ReconstructionCorrectionProposal,
} from "./correction-proposal-contract";

type ProposalStore = Pick<WorthlineStore, "liabilities"> & {
  assistantProposals: AssistantProposalStore;
};

export interface ReconstructionArgs {
  /** Internal liability id, already resolved from the public wl_hld_… id. */
  liabilityId: string;
  /** The wl_hld_… id echoed back to the card and stored in the plan. */
  publicHoldingId: string;
  rows: unknown;
  summary?: string;
  documentName?: string;
}

export type ReconstructionBuildResult =
  | { ok: true; proposal: ReconstructionCorrectionProposal }
  | { ok: false; error: string };

/**
 * Map one projected preview row to a superficie-C series point. Only "accepted"
 * rows are included in the endpoint; "excluded"/"skipped" rows are shown folded
 * with their reason and never move the reconciliation.
 */
function toSeriesPoint(preview: {
  date: string;
  balanceMinor: number;
  status: "accepted" | "excluded" | "skipped";
  reason?: string;
  driftMinor: number | null;
}): CorrectionSeriesPoint {
  return {
    balanceMinor: preview.balanceMinor,
    date: preview.date,
    driftMinor: preview.driftMinor,
    excluded: preview.status !== "accepted",
    origin: "assistant",
    ...(preview.reason === undefined ? {} : { reason: preview.reason }),
  };
}

export async function buildReconstructionProposal(
  store: ProposalStore,
  args: ReconstructionArgs,
  today: string,
): Promise<ReconstructionBuildResult> {
  const parsed = parseBalanceHistoryRows(args.rows);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const projected = await projectBalanceHistoryProposal(
    store,
    args.liabilityId,
    parsed.rows,
    today,
  );
  if (!projected.ok) return { ok: false, error: projected.error };

  const series = projected.plan.previews.map(toSeriesPoint);
  const anchorMinor = projected.reconciliation.expectedMinor;
  // Persist only the observed date + balance (never an inferred parameter); the
  // confirm re-projects this raw series against live data as the revalidation.
  const observations = parsed.rows.map(({ balanceMinor, date }) => ({
    balanceMinor,
    date,
  }));
  const proposal = await store.assistantProposals.create({ kind: "correction" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name:
        typeof args.documentName === "string" && args.documentName.trim()
          ? args.documentName.trim().slice(0, 255)
          : "serie-de-saldos",
      provenance: "agent",
      sha256: createHash("sha256").update(JSON.stringify(observations)).digest("hex"),
    },
    facts: [
      {
        kind: "holding_correction",
        row: {
          // before = the live balance the draft was armed against (undo/audit).
          before: { balanceMinor: anchorMinor },
          holding: args.publicHoldingId,
          liabilityId: args.liabilityId,
          mode: "reconstruct",
          observations,
        },
      },
    ],
  });

  // The pristine guarantee is the engine's own reconciliation (the reconstructed
  // curve's endpoint vs the live anchor) — the strong check the PRD demands. The
  // card shows a lightweight hint as the user excludes/edits points, and the
  // confirm re-projects the edited series server-side (authoritative) before applying.
  const guarantee: CorrectionGuarantee = {
    anchorMinor,
    resultingMinor: projected.reconciliation.resultingMinor,
    state: projected.reconciliation.matches ? "reconciled" : "mismatch",
  };

  return {
    ok: true,
    proposal: {
      anchorMinor,
      curve: projected.curve,
      draft: { proposalId: proposal.id },
      folio: CORRECTION_FOLIO,
      guarantee,
      holding: { id: args.publicHoldingId, name: projected.liability.name },
      mode: "reconstruir",
      proposalType: "correction",
      series,
      summary: args.summary?.trim() || `Reconstrucción de «${projected.liability.name}»`,
    },
  };
}
