/**
 * FIRE level milestones (PRD #507 N1, issue #513).
 *
 * Returns Coast · Lean · Regular · Fat targets + ETA over the base trajectory,
 * coherent with goalFireDelay (both use the same fractionalFireYear interpolation).
 *
 * - Regular  = monthlySpending * 12 / SWR
 * - Lean     = Regular * leanMultiplier  (default 0.7, overridable in FireScopeConfig)
 * - Fat      = Regular * fatMultiplier   (default 1.5, overridable in FireScopeConfig)
 * - Coast    = fireNumber / growthFactor (reuses calculateFire coast math from fire.ts)
 *              Only present when currentAge is configured.
 *
 * Returns null when config is degenerate (SWR or spending = 0) — caller hides the rail.
 */

import type { CurrencyCode } from "./money";
import type { FireScopeConfig } from "./fire";
import { calculateFire } from "./fire";
import { projectFire, fractionalFireYear } from "./fire-projection";

export type FireLevelKey = "coast" | "lean" | "barista" | "regular" | "fat";

export type FireLevelEta =
  | { kind: "reached" }
  | { kind: "eta"; years: number }
  | { kind: "unreachable" };

export interface FireLevel {
  key: FireLevelKey;
  label: string;
  amountMinor: number;
  eta: FireLevelEta;
}

export interface FireLevelsInput {
  config: FireScopeConfig;
  /** Current eligible assets in minor units (net of goal reservations, same as the chart). */
  eligibleMinor: number;
  currency: CurrencyCode;
  /**
   * The single resolved real return to use (N3, #515). Pass `fireResult.realReturnUsed`
   * so coast + projection + levels all use the same rate. Falls back to
   * `config.expectedRealReturn ?? 0.05` when omitted (backward-compat).
   */
  resolvedRealReturn?: number;
}

const LEAN_DEFAULT = 0.7;
const FAT_DEFAULT = 1.5;
const LABEL: Record<FireLevelKey, string> = {
  coast: "Coast",
  lean: "Lean",
  barista: "Barista",
  regular: "Regular",
  fat: "Fat",
};

/** Returns null when config is degenerate — caller should hide the rail. */
export function fireLevels(input: FireLevelsInput): FireLevel[] | null {
  const { config, eligibleMinor, currency, resolvedRealReturn } = input;
  const { monthlySpendingMinor, safeWithdrawalRate } = config;
  // N3 (#515): use the caller-supplied resolved rate (fireResult.realReturnUsed)
  // so coast + projection + levels all agree on the same scalar.
  const expectedRealReturn = resolvedRealReturn ?? config.expectedRealReturn ?? 0.05;

  if (!safeWithdrawalRate || !monthlySpendingMinor) return null;

  const leanMult = config.leanMultiplier ?? LEAN_DEFAULT;
  const fatMult = config.fatMultiplier ?? FAT_DEFAULT;

  const regularAmount = Math.round((monthlySpendingMinor * 12) / safeWithdrawalRate);
  const leanAmount = Math.round(
    (monthlySpendingMinor * leanMult * 12) / safeWithdrawalRate,
  );
  const fatAmount = Math.round(
    (monthlySpendingMinor * fatMult * 12) / safeWithdrawalRate,
  );

  // Coast amount: pass the resolved rate so coast uses the SAME scalar as the
  // projection ETAs and everything else on this rail (CRITICAL-2 fix, N3 #515).
  const fireResult = calculateFire(config, eligibleMinor, currency, expectedRealReturn);
  const coastAmountMinor = fireResult.coastFireRequired?.amountMinor ?? null;

  // Single projection run with fireNumberMinor = fatAmount so the trajectory is
  // tall enough to cross every level. All four levels interpolate on this trajectory.
  const monthlyContribution = config.monthlySavingsCapacityMinor ?? 0;
  const projection = projectFire({
    startingEligibleMinor: eligibleMinor,
    monthlyContributionMinor: monthlyContribution,
    expectedRealReturn,
    fireNumberMinor: fatAmount,
  });
  const base = projection.scenarios.find((s) => s.label === "base")!;

  function etaForAmount(targetMinor: number): FireLevelEta {
    if (eligibleMinor >= targetMinor) return { kind: "reached" };
    const frac = fractionalFireYear(base.trajectory, targetMinor, base.yearsToFire);
    if (frac === null) return { kind: "unreachable" };
    return { kind: "eta", years: Math.round(frac * 10) / 10 };
  }

  const levels: FireLevel[] = [
    {
      key: "lean",
      label: LABEL.lean,
      amountMinor: leanAmount,
      eta: etaForAmount(leanAmount),
    },
  ];

  // Barista FIRE (N2, #514): part-time income shrinks the required nest egg.
  // Only emit when income > 0; clamp amount to ≥ 0 (income ≥ spending is fine).
  const baristaIncome = config.baristaMonthlyIncomeMinor ?? 0;
  if (baristaIncome > 0) {
    const baristaAmount = Math.max(
      0,
      Math.round(((monthlySpendingMinor - baristaIncome) * 12) / safeWithdrawalRate),
    );
    levels.push({
      key: "barista",
      label: LABEL.barista,
      amountMinor: baristaAmount,
      eta: etaForAmount(baristaAmount),
    });
  }

  levels.push(
    {
      key: "regular",
      label: LABEL.regular,
      amountMinor: regularAmount,
      eta: etaForAmount(regularAmount),
    },
    {
      key: "fat",
      label: LABEL.fat,
      amountMinor: fatAmount,
      eta: etaForAmount(fatAmount),
    },
  );

  if (coastAmountMinor !== null && config.currentAge !== undefined) {
    levels.unshift({
      key: "coast",
      label: LABEL.coast,
      amountMinor: coastAmountMinor,
      eta: etaForAmount(coastAmountMinor),
    });
  }

  return levels;
}
