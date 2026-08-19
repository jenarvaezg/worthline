/**
 * FIRE level milestones (PRD #507 N1, issue #513).
 *
 * Returns Lean · Barista · Regular · Fat targets + ETA over the base trajectory,
 * coherent with goalFireDelay (both use the same fractionalFireYear interpolation).
 *
 * - Regular  = monthlySpending * 12 / SWR
 * - Lean     = Regular * leanMultiplier  (default 0.7, overridable in FireScopeConfig)
 * - Fat      = Regular * fatMultiplier   (default 1.5, overridable in FireScopeConfig)
 *
 * Every level on this rail answers ONE question — «¿qué nivel de vida quiero
 * financiar?» — and that is why Coast is not among them (#1425, ADR 0079). Coast answers a
 * different one, «¿en qué punto de financiación estoy?»: a state, not a spending
 * target. It rode this rail until the card needed a paragraph underneath explaining
 * that it did not mean what the other cards mean, which was the confession. Coast now
 * lives beside the progress bar it was always about, with `fireCoastArrival` dating it.
 * Barista is a third case and it DOES belong here: part-time income shrinks the deficit
 * the capital has to cover, so it is a spending target with less to fund.
 *
 * Returns null when config is degenerate (SWR or spending = 0) — caller hides the rail.
 */

import type { FireContext } from "./fire";
import { projectFireFromContext } from "./fire";
import { fractionalFireYear } from "./fire-projection";
import { monthlySavingsCapacityForFire } from "./fire-savings-capacity";

export type FireLevelKey = "lean" | "barista" | "regular" | "fat";

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
   * Required since Coast left the rail (#1425): every level here IS a spending target,
   * so every one of them can say what it funds. Barista's is the gap its part-time
   * income leaves for the capital to cover.
   */
  fundsAnnualMinor: number;
  /**
   * The multiple of declared spending this level stands for (`0.7` for Lean by
   * default) — the input behind `amountMinor`, so a caller can say «tu mismo gasto al
   * 70 %» without keeping its own copy of the default. Absent where the level is not
   * a multiple of spending (`barista`).
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
  lean: "Lean",
  barista: "Barista",
  regular: "Regular",
  fat: "Fat",
};

/** Returns null when config is degenerate — caller should hide the rail. */
export function fireLevels(input: FireLevelsInput): FireLevel[] | null {
  const { context } = input;
  const { config, eligibleMinor } = context;
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

  return levels;
}
