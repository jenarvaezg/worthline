/**
 * Correction plan (#1051, PRD #1048) — the payload of a `correction` assistant
 * proposal. A chat-declared, previewable diff of dated facts + parameter edits
 * that repairs ONE mis-modeled holding (the only exception being the atomic
 * debt↔asset pair in an ownership fix). Every write primitive it dispatches to
 * already shipped in #997; the one command it needed that did not exist —
 * `changeDebtModel` — ships alongside it.
 *
 * S3 covers the "anchor-only" depth ("Solo desde hoy"): the correction declares
 * the real value from today forward and never rewrites the past (ADR 0056). S5
 * (#1053) adds the "reconstruct" depth ("Reconstruir historia"): a document-driven
 * dated balance series reconstructed as a chain of re-baselines and reconciled to
 * the live anchor, applied as ONE atomic batch with ONE ripple from the oldest
 * affected date. Both depths share the superficie C surface and this proposal kind.
 *
 * Before-values of edited facts live IN the applied proposal (this payload), not
 * in `fact_batch` — respecting the #889 provenance sliver while leaving the
 * undo-by-batch door open.
 */

import type {
  CreateInvestmentOperationInput,
  DebtModel,
  InstrumentIdentityPatch,
  ValuationCadence,
} from "@worthline/domain";
import type { AddValuationAnchorInput, UpdateAssetInput } from "./asset-store";
import type { UpdateAmortizationPlanInput } from "./liability-amortization-plan-store";
import type { AddBalanceAnchorInput } from "./liability-balance-anchor-store";
import type { AddBalanceRebaselineInput } from "./liability-balance-rebaseline-store";
import type { UpdateLiabilityInput } from "./liability-store";
import type { UpdateInvestmentOperationInput } from "./operations-store";

export type CorrectionMode = "anchor-only" | "reconstruct";

/** A money value known when the draft was armed, kept for provenance/undo. */
export type CorrectionBeforeMoney = { balanceMinor: number | null };

/**
 * Each edit carries what to write (`input`/`patch`/…) and the live `before` it
 * replaces. The apply re-checks the target's live balance (see `revalidation`)
 * before touching anything, so a stale draft fails honestly and nothing persists.
 */
export type CorrectionEdit =
  | {
      kind: "debt_rebaseline";
      before: CorrectionBeforeMoney;
      input: AddBalanceRebaselineInput;
    }
  | {
      kind: "balance_anchor";
      before: CorrectionBeforeMoney;
      input: AddBalanceAnchorInput;
    }
  | {
      kind: "valuation_anchor";
      before: { valueMinor: number | null };
      input: AddValuationAnchorInput;
    }
  | {
      kind: "debt_model";
      liabilityId: string;
      before: DebtModel | null;
      debtModel: DebtModel;
    }
  | {
      kind: "liability_cadence";
      liabilityId: string;
      before: ValuationCadence | null;
      cadence: ValuationCadence | null;
    }
  | {
      kind: "housing_cadence";
      assetId: string;
      before: ValuationCadence | null;
      cadence: ValuationCadence | null;
    }
  | {
      kind: "amortization_plan";
      liabilityId: string;
      planId: string;
      before: Record<string, unknown>;
      input: UpdateAmortizationPlanInput;
    }
  | {
      kind: "liability_config";
      liabilityId: string;
      before: Record<string, unknown>;
      patch: UpdateLiabilityInput;
    }
  | {
      kind: "asset_config";
      assetId: string;
      before: Record<string, unknown>;
      patch: UpdateAssetInput;
    }
  | {
      /**
       * Fill an investment's empty ISIN / provider symbol (#1349). Carries the
       * declaration, not a full metadata row: the apply re-resolves it against
       * live data through `resolveInstrumentIdentityFill`, so a draft armed when
       * the field was empty cannot overwrite what a sibling proposal — or the
       * ficha — wrote in the meantime.
       */
      kind: "investment_identity";
      assetId: string;
      before: { isin: string | null; providerSymbol: string | null };
      declaration: InstrumentIdentityPatch;
    }
  | {
      kind: "investment_operations";
      assetId: string;
      before: Record<string, unknown>;
      creates: CreateInvestmentOperationInput[];
      overwrites: UpdateInvestmentOperationInput[];
      deletes: string[];
    };

export type CorrectionEditKind = CorrectionEdit["kind"];

/**
 * A cheap staleness check run at confirm time: the target liability's live
 * balance at `asOf` must still equal what the draft was built against. Present
 * for debt corrections (where ripple/anchors can move the figure between drafting
 * and confirming); asset valuation-anchor corrections are declarative and omit it.
 */
export interface CorrectionRevalidation {
  liabilityId: string;
  asOf: string;
  expectedBalanceMinor: number;
}

/**
 * One observed dated balance read from a statement or amortization schedule —
 * the raw series the reconstruct depth persists for provenance. Only the
 * *observed* balance and its date are kept; loan parameters (rate, payment, term)
 * are never inferred nor stored — the reconstruction re-derives the rate from the
 * debt's own amortization curve (PRD #1048 S4/S5, "únicamente saldos observados").
 */
export interface DatedBalanceObservation {
  date: string;
  balanceMinor: number;
}

/** The "Solo desde hoy" depth (#1051): declared facts applied from today forward. */
export interface AnchorOnlyCorrectionPlan {
  mode: "anchor-only";
  /** The public holding id the whole correction is about (echoed for the card). */
  holding: string;
  edits: CorrectionEdit[];
  revalidation?: CorrectionRevalidation;
}

/**
 * One point of the observed series the assistant amended on the user's behalf
 * (#1423) — the chat equivalent of the card's two per-point controls: the «Excluir»
 * checkbox and the editable amount. A LAYER over {@link DatedBalanceObservation},
 * never a rewrite of it: the observed series keeps saying what the document said,
 * and the effective series is derived from both. Keyed by date, because an
 * amortization schedule repeats a date when that day carried two events (#1422) and
 * an index into a series the engine re-sorts would point at the wrong row.
 */
export interface ReconstructPointAmendment {
  date: string;
  /** Left out of the applied series (the card's checkbox, pre-checked). */
  excluded?: boolean;
  /** The amount the user corrected through the chat, in minor units. */
  balanceMinor?: number;
}

/**
 * The "Reconstruir historia" depth (#1053): the raw dated balance series and the
 * live anchor it was armed against. The composed re-baseline chain is NOT baked
 * in — the confirm re-projects the (possibly point-edited) series against live
 * data, so a stale draft or a series that no longer reconciles fails honestly.
 * `before` is the live balance when the draft was armed (persisted for undo/audit).
 */
export interface ReconstructCorrectionPlan {
  mode: "reconstruct";
  holding: string;
  liabilityId: string;
  observations: DatedBalanceObservation[];
  before: CorrectionBeforeMoney;
  /** What the assistant excluded or corrected point by point (#1423). */
  amendments?: ReconstructPointAmendment[];
  /**
   * The draft this one amends (#1423). An amendment prepares a NEW proposal from
   * the previous one and discards it, so the thread keeps the trail and the
   * superseded card can no longer be applied over the top of this one.
   */
  amendedFrom?: string;
}

export type CorrectionPlan = AnchorOnlyCorrectionPlan | ReconstructCorrectionPlan;
