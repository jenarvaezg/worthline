/**
 * Passive-income lens for /objetivos (#658) — "how much of my spending do my
 * holdings already pay?".
 *
 * A read-only view: it consumes the payouts the S1 module already collected
 * (`collectHoldingPayouts`) and the trailing-window aggregator
 * (`passiveIncomeTrailing`), and derives nothing itself. Its own job is the two
 * things the returns/ficha surfaces don't do here: weight each holding's payouts
 * by the *selected scope's* ownership share, and phrase coverage against declared
 * spending honestly — coverage is shown only when spending is known, and a payout
 * recorded partway through the window is summed as-is, never annualized.
 */

import { allocateByBps } from "./money";
import type { DatedAmount } from "./payouts";
import { passiveIncomeTrailing } from "./payouts";
import type { OwnershipShare } from "./workspace-types";

export interface PassiveIncomeLens {
  /** Scope-weighted sum of payouts in the trailing window (minor units). */
  totalMinor: number;
  /** Number of payout occurrences inside the window (each counted once). */
  count: number;
  /** Exclusive lower bound of the trailing window (YYYY-MM-DD). */
  windowStartISO: string;
  /** Inclusive upper bound — today (YYYY-MM-DD). */
  windowEndISO: string;
  /** Declared annual spending (monthly × 12), or null when spending is unknown. */
  annualSpendingMinor: number | null;
  /** totalMinor / annualSpendingMinor, or null when spending is unknown. */
  coverageRatio: number | null;
  /** Whether the scope has any recorded payout at all (drives the empty state). */
  hasPayouts: boolean;
}

export interface ScopePassiveIncomeInput {
  /** Every recorded payout up to today, keyed by holding id (from collectHoldingPayouts). */
  payoutsByHolding: ReadonlyMap<string, readonly DatedAmount[]>;
  /** The scope's candidate holdings with their ownership split. */
  holdings: ReadonlyArray<{ id: string; ownership: OwnershipShare[] }>;
  /** Member ids that constitute the selected scope (from resolveScopeMemberIds). */
  scopeMemberIds: ReadonlySet<string>;
  /** Declared monthly spending for the scope, or null to omit coverage. */
  monthlySpendingMinor: number | null;
  /** Today (YYYY-MM-DD). */
  todayISO: string;
  /** Trailing window length in months (default 12). */
  months?: number;
}

/** The scope's basis-point stake in a holding (0–10_000). */
function scopeShareBps(
  ownership: OwnershipShare[],
  scopeMemberIds: ReadonlySet<string>,
): number {
  return ownership
    .filter((share) => scopeMemberIds.has(share.memberId))
    .reduce((sum, share) => sum + share.shareBps, 0);
}

export function scopePassiveIncome(input: ScopePassiveIncomeInput): PassiveIncomeLens {
  const { payoutsByHolding, holdings, scopeMemberIds, monthlySpendingMinor, todayISO } =
    input;
  const months = input.months ?? 12;

  // Weight each holding's payouts by the scope's ownership share, dropping
  // holdings the scope does not own (shareBps 0) so they never reach the window.
  const weighted: DatedAmount[] = [];
  for (const holding of holdings) {
    const shareBps = scopeShareBps(holding.ownership, scopeMemberIds);
    if (shareBps === 0) continue;
    const rows = payoutsByHolding.get(holding.id);
    if (!rows) continue;
    for (const row of rows) {
      weighted.push({
        dateISO: row.dateISO,
        amountMinor: allocateByBps(row.amountMinor, shareBps),
      });
    }
  }

  const window = passiveIncomeTrailing(weighted, todayISO, months);

  // Coverage compares the trailing total against declared annual spending. This
  // is coherent only while the window is the default 12 months; the sole caller
  // uses it, and `months` is not otherwise exposed.
  const annualSpendingMinor =
    monthlySpendingMinor != null && monthlySpendingMinor > 0
      ? monthlySpendingMinor * 12
      : null;
  const coverageRatio = annualSpendingMinor
    ? window.totalMinor / annualSpendingMinor
    : null;

  return {
    totalMinor: window.totalMinor,
    count: window.count,
    windowStartISO: window.windowStartISO,
    windowEndISO: window.windowEndISO,
    annualSpendingMinor,
    coverageRatio,
    hasPayouts: weighted.length > 0,
  };
}
