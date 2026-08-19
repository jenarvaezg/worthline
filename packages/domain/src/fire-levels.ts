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

import type { FireContext } from "./fire";
import { calculateFire, projectFireFromContext } from "./fire";
import { fractionalFireYear } from "./fire-projection";
import { monthlySavingsCapacityForFire } from "./fire-savings-capacity";

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
  /**
   * The annual spending this level is DEFINED by (minor units) — what its capital
   * funds at the configured withdrawal rate (#1426). A capital figure alone says
   * nothing about the life it pays for, and re-deriving it on screen would mean
   * inverting the division that produced the amount (ADR 0077).
   *
   * Absent on `coast`: coast is defined by the FIRE number and the years left to the
   * target age, not by a multiple of spending — «financia X €/año» would read as an
   * invitation to withdraw from capital that exists precisely to be left alone.
   */
  fundsAnnualMinor?: number;
  /**
   * The multiple of declared spending this level stands for (`0.7` for Lean by
   * default) — the input behind `amountMinor`, so a caller can say «tu mismo gasto al
   * 70 %» without keeping its own copy of the default. Absent where the level is not
   * a multiple of spending (`coast`, `barista`).
   */
  spendingMultiplier?: number;
}

export interface FireLevelsInput {
  /**
   * The resolved FIRE context (#1026): carries the config, the net-eligible
   * total, the currency and the single resolved rate together. Coast, the
   * projection ETAs and every level use `context.realReturnUsed` — there is no
   * loose rate to forget and no fallback.
   */
  context: FireContext;
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
  const { context } = input;
  const { config, currency, realReturnUsed: expectedRealReturn, eligibleMinor } = context;
  const { monthlySpendingMinor, safeWithdrawalRate } = config;

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

  // #1416: the declared scalar is the only savings input the projection takes,
  // so this rail cannot disagree with the chart about how much is contributed.
  const monthlyContribution = monthlySavingsCapacityForFire(config);
  const projection = projectFireFromContext(context, {
    monthlyContributionMinor: monthlyContribution,
    // Project to Fat so the single trajectory is tall enough to cross every
    // level; all four levels interpolate on it (rate/age ride in the context).
    fireNumberMinor: fatAmount,
  });
  const base = projection.scenarios.find((s) => s.label === "base")!;

  function etaForAmount(targetMinor: number): FireLevelEta {
    if (eligibleMinor >= targetMinor) return { kind: "reached" };
    const frac = fractionalFireYear(base.trajectory, targetMinor, base.yearsToFire);
    if (frac === null) return { kind: "unreachable" };
    return { kind: "eta", years: Math.round(frac * 10) / 10 };
  }

  const annualSpendingMinor = monthlySpendingMinor * 12;

  const levels: FireLevel[] = [
    {
      key: "lean",
      label: LABEL.lean,
      amountMinor: leanAmount,
      eta: etaForAmount(leanAmount),
      fundsAnnualMinor: Math.round(annualSpendingMinor * leanMult),
      spendingMultiplier: leanMult,
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
      // Part-time income covers the rest, so what the CAPITAL funds is the gap.
      fundsAnnualMinor: Math.max(0, (monthlySpendingMinor - baristaIncome) * 12),
    });
  }

  levels.push(
    {
      key: "regular",
      label: LABEL.regular,
      amountMinor: regularAmount,
      eta: etaForAmount(regularAmount),
      fundsAnnualMinor: annualSpendingMinor,
      spendingMultiplier: 1,
    },
    {
      key: "fat",
      label: LABEL.fat,
      amountMinor: fatAmount,
      eta: etaForAmount(fatAmount),
      fundsAnnualMinor: Math.round(annualSpendingMinor * fatMult),
      spendingMultiplier: fatMult,
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
