import type { CurrencyCode, MoneyMinor } from "./money";

import { money } from "./money";
import type { LiquidityTier } from "./liquidity-ladder";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";
import { resolveScopeMemberIds } from "./scope";
import { allocateScopedHolding } from "./scope-allocation";
import { tierOfAsset } from "./classification";
import { effectiveRealReturn } from "./fire-return";

export interface FireScopeConfig {
  monthlySpendingMinor: number;
  safeWithdrawalRate: number;
  /**
   * Manual override for the expected real return (N3, #515). When set, this
   * value is used as-is (backward-compatible with existing stored configs).
   * When absent, `calculateFireForScope` computes an effective rate from the
   * weighted tier mix of the eligible pool.
   */
  expectedRealReturn?: number;
  /**
   * Per-tier real-return overrides (N3, #515). Optional; when absent the
   * tier defaults from `TIER_REAL_RETURN_DEFAULTS` are used. Only affects
   * the effective rate computation (ignored when `expectedRealReturn` is set).
   */
  tierRealReturns?: Partial<Record<LiquidityTier, number>>;
  currentAge?: number;
  targetRetirementAge?: number;
  excludedAssetIds?: string[];
  /**
   * Editable monthly savings capacity in minor units (PRD #421, #425): the
   * default contribution the FIRE projection assumes. Optional — when unset the
   * UI offers a suggestion from operations history (`suggestMonthlySavingsCapacity`)
   * but never writes it implicitly; the projection treats `undefined` as 0.
   */
  monthlySavingsCapacityMinor?: number;
  /**
   * Spending multiplier for Lean FIRE level (PRD #507 N1). Default 0.7.
   * Stored as a decimal fraction (e.g. 0.7, not 70).
   */
  leanMultiplier?: number;
  /**
   * Spending multiplier for Fat FIRE level (PRD #507 N1). Default 1.5.
   * Stored as a decimal fraction (e.g. 1.5, not 150).
   */
  fatMultiplier?: number;
  /**
   * Barista FIRE: part-time income in minor units/month (PRD #507 N2, #514).
   * When > 0, lowers the FIRE number to cover only (spending − income).
   * 0 / undefined → no Barista level shown.
   */
  baristaMonthlyIncomeMinor?: number;
}

/**
 * Why an asset is held out of the FIRE-eligible total. `primary_residence`
 * comes from the asset's own flag; `manual` comes from `config.excludedAssetIds`.
 */
export type FireExclusionReason = "primary_residence" | "manual";

export interface FireExcludedAsset {
  id: string;
  name: string;
  reason: FireExclusionReason;
}

export interface FireResult {
  fireNumber: MoneyMinor;
  eligibleAssets: MoneyMinor;
  percentFunded: number;
  /**
   * Capital reserved for goals due before FIRE (PRD #421, #426), already
   * subtracted from `eligibleAssets`. Present (≥ 0) on `calculateFireForScope`;
   * absent on `calculateFire`, which only sees a pre-computed eligible total.
   * It NEVER touches gross assets, net worth or liquid net worth — only FIRE.
   */
  reservedForGoals?: MoneyMinor;
  /**
   * Assets owned within the scope that were left OUT of `eligibleAssets`, with
   * the reason. Powers the dashboard "¿Qué cuenta como elegible?" disclosure
   * (#266). Empty for `calculateFire` (it only sees a total, not the assets).
   */
  excludedAssets: FireExcludedAsset[];
  coastFireRequired?: MoneyMinor;
  coastFireAge?: number;
  isAlreadyAtCoastFire?: boolean;
  /**
   * Weighted real return estimate from the eligible tier mix (N3, #515).
   * Σ(tier_weight × tier_return) over the eligible pool. Always present on
   * `calculateFireForScope`; absent on `calculateFire` (no tier info available).
   */
  effectiveRealReturn?: number;
  /**
   * The single resolved rate used for ALL projection math in this result
   * (coast, scenarios, levels, «+X meses»). = `config.expectedRealReturn` when
   * an override is set; = `effectiveRealReturn` otherwise (N3, #515).
   * Always present on `calculateFireForScope`; absent on `calculateFire`.
   */
  realReturnUsed?: number;
}

/**
 * The FIRE horizon a goal's deadline is measured against (PRD #421, #426): the
 * target-retirement date implied by `currentAge`/`targetRetirementAge`. Without
 * an age there is no horizon (`undefined` → every future goal reserves). A
 * horizon already in the past (at/over the target age) collapses to `now`, so
 * nothing reserves. `now` is an ISO date (YYYY-MM-DD); the result keeps its
 * month-day, so lexicographic comparison against deadlines stays correct.
 */
export function fireReservationHorizon(
  config: FireScopeConfig,
  now: string,
): string | undefined {
  if (config.currentAge === undefined) {
    return undefined;
  }

  const years = (config.targetRetirementAge ?? 65) - config.currentAge;
  if (years <= 0) {
    return now;
  }

  return `${Number(now.slice(0, 4)) + years}${now.slice(4)}`;
}

/**
 * Core FIRE math (engine-level). Accepts an explicit `realReturn` so the
 * caller controls the rate — coast and coastFireAge use this single value.
 * When called from `calculateFireForScope` the rate is `realReturnUsed`
 * (the resolved override-or-effective scalar, N3 #515).
 */
export function calculateFire(
  config: FireScopeConfig,
  eligibleAssetsMinor: number,
  currency: CurrencyCode,
  /** Resolved real return to use for coast math. Defaults to `config.expectedRealReturn ?? 0.05`. */
  realReturn?: number,
): FireResult {
  const rate = realReturn ?? config.expectedRealReturn ?? 0.05;

  const fireNumberMinor = Math.round(
    (config.monthlySpendingMinor * 12) / config.safeWithdrawalRate,
  );

  const percentFunded =
    fireNumberMinor > 0 ? (eligibleAssetsMinor / fireNumberMinor) * 100 : 0;

  const result: FireResult = {
    fireNumber: money(fireNumberMinor, currency),
    eligibleAssets: money(eligibleAssetsMinor, currency),
    percentFunded,
    excludedAssets: [],
  };

  if (config.currentAge !== undefined) {
    const targetRetirementAge = config.targetRetirementAge ?? 65;
    const yearsToRetirement = targetRetirementAge - config.currentAge;
    const growthFactor = Math.pow(1 + rate, yearsToRetirement);
    const coastFireRequiredMinor = Math.round(fireNumberMinor / growthFactor);

    result.coastFireRequired = money(coastFireRequiredMinor, currency);
    result.isAlreadyAtCoastFire = eligibleAssetsMinor >= coastFireRequiredMinor;

    if (eligibleAssetsMinor > 0 && fireNumberMinor > eligibleAssetsMinor) {
      result.coastFireAge =
        config.currentAge +
        Math.log(fireNumberMinor / eligibleAssetsMinor) / Math.log(1 + rate);
    }
  }

  return result;
}

export function calculateFireForScope(
  config: FireScopeConfig,
  assets: ManualAsset[],
  liabilities: Liability[],
  workspace: Workspace,
  scopeId: string,
  /**
   * Capital reserved for goals due before FIRE (PRD #421, #426). Subtracted from
   * the scope-eligible total before the FIRE math; defaults to 0 (no goals).
   */
  reservedForGoalsMinor = 0,
): FireResult {
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, scopeId));
  const excludedSet = new Set(config.excludedAssetIds ?? []);

  let eligibleAssetsMinor = 0;
  const excludedAssets: FireExcludedAsset[] = [];
  const excludedAssetIds = new Set<string>();
  // Accumulate eligible minor units per tier for weighted return computation (N3, #515).
  const eligibleByTierMinor: Partial<Record<string, number>> = {};

  for (const asset of assets) {
    const ownedMinor = allocateScopedHolding(asset.currentValue.amountMinor, {
      ownership: asset.ownership,
      scopeMemberIds,
    }).ownedMinor;

    const reason: FireExclusionReason | null = asset.isPrimaryResidence
      ? "primary_residence"
      : excludedSet.has(asset.id)
        ? "manual"
        : null;

    if (reason === null) {
      eligibleAssetsMinor += ownedMinor;
      // Accumulate by tier for the weighted return calculation.
      const tier = tierOfAsset(asset);
      eligibleByTierMinor[tier] = (eligibleByTierMinor[tier] ?? 0) + ownedMinor;
      continue;
    }

    excludedAssetIds.add(asset.id);
    // Scope-relative: only surface what the scope actually holds. An excluded
    // asset owned entirely outside this scope contributes nothing either way,
    // so listing it would just be noise.
    if (ownedMinor > 0) {
      excludedAssets.push({ id: asset.id, name: asset.name, reason });
    }
  }

  // Net the scope's debt against eligible capital: coast/FIRE measures what you
  // could draw down, and a mortgage or loan is capital you don't own. A liability
  // secured against an EXCLUDED asset (primary residence / manual) is dropped with
  // that asset — netting it too would double-count the exclusion.
  let scopedDebtMinor = 0;
  for (const liability of liabilities) {
    if (
      liability.associatedAssetId &&
      excludedAssetIds.has(liability.associatedAssetId)
    ) {
      continue;
    }
    scopedDebtMinor += allocateScopedHolding(liability.currentBalance.amountMinor, {
      ownership: liability.ownership,
      scopeMemberIds,
    }).ownedMinor;
  }
  // ponytail: clamp at 0 — an underwater scope reads as 0 drawable capital, not
  // negative coast math. Tier weights stay gross (debt only shifts the level).
  const netEligibleMinor = Math.max(0, eligibleAssetsMinor - scopedDebtMinor);

  // N3 (#515): compute effective weighted rate, then resolve the single rate to use.
  const effective = effectiveRealReturn({
    eligibleByTierMinor,
    ...(config.tierRealReturns ? { tierRealReturns: config.tierRealReturns } : {}),
  });
  const realReturnUsed = config.expectedRealReturn ?? effective;

  const reserved = Math.max(0, Math.min(reservedForGoalsMinor, netEligibleMinor));
  const eligibleAfterReservation = netEligibleMinor - reserved;

  return {
    ...calculateFire(
      config,
      eligibleAfterReservation,
      workspace.baseCurrency,
      realReturnUsed,
    ),
    excludedAssets,
    reservedForGoals: money(reserved, workspace.baseCurrency),
    effectiveRealReturn: effective,
    realReturnUsed,
  };
}
