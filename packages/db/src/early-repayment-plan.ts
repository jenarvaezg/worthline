/**
 * Early-repayment plan (#1245, PRD #1241) — the payload of an `early_repayment`
 * assistant proposal. A chat-declared, previewable DATED FACT: the lump the user
 * says they paid, on the date they paid it, against ONE amortizable debt.
 *
 * It is deliberately a fact, not a re-baseline. `propose_correction`'s
 * `declare_balance` repairs the symptom from today forward and loses the cause;
 * this registers the cause, so the curve before the repayment stays untouched and
 * the engine re-derives everything after it (`amortization.ts`, `ripple-engine.ts`).
 *
 * The whole write is reconstructed from this row at confirm time — the web layer
 * cannot smuggle a different amount past the preview the user agreed to.
 */

import type { EarlyRepaymentMode } from "@worthline/domain";

export interface EarlyRepaymentPlan {
  /** The public holding id (`wl_hld_…`) the card echoes. */
  holding: string;
  /** Internal liability id the repayment belongs to. */
  liabilityId: string;
  /** The amortization plan row the repayment hangs off. */
  planId: string;
  /** YYYY-MM-DD the repayment was made (NOT necessarily its month boundary). */
  repaymentDate: string;
  /** Principal repaid, integer minor units. */
  amountMinor: number;
  /** What the user confirmed in the preview; never silently inferred. */
  mode: EarlyRepaymentMode;
  /**
   * The cheap staleness check the apply runs (mirrors `CorrectionRevalidation`):
   * the debt's live balance at `asOf` must still be what the draft was armed
   * against, so a curve that moved between drafting and confirming fails honestly
   * instead of writing arithmetic the user never previewed.
   */
  revalidation: { asOf: string; expectedBalanceMinor: number };
}
