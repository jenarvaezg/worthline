import type { ContributionPlan } from "./contribution-plan";
import { assembleFireEligiblePool, type FireExcludedAsset } from "./fire-eligible-pool";
import type { FireGrowthAssumption } from "./fire-plan-projection";
import { projectFireWithContributionPlan } from "./fire-plan-projection";
import type { FireProjection } from "./fire-projection";
import { projectFire } from "./fire-projection";
import { effectiveRealReturn } from "./fire-return";
import type { LiquidityTier } from "./liquidity-ladder";
import type { CurrencyCode, MoneyMinor } from "./money";
import { money } from "./money";
import type { Liability, ManualAsset, Workspace } from "./workspace-types";

export type { FireExcludedAsset, FireExclusionReason } from "./fire-eligible-pool";

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
}

/**
 * The resolved FIRE inputs that every downstream projection needs, packaged as
 * one value so the rate can never travel apart from the totals it was resolved
 * against (#1026). `calculateFireForScope` produces it; *levels*, *goal delay*
 * and *projection* consume it instead of a loose optional rate. Once you hold a
 * context there is no rate `?? fallback` to reach for — having the context IS
 * having the rate. (A caller with no FIRE config at all has no context, and may
 * still default a display rate; that's the absence-of-config case, not this one.)
 *
 * The only sanctioned way to change the rate for a what-if is `withRate`, which
 * returns a fresh context — an explicit override, never a silent divergence.
 */
export interface FireContext {
  /** The scope config these totals + rate were resolved from. */
  readonly config: FireScopeConfig;
  readonly currency: CurrencyCode;
  /**
   * The single resolved real return for ALL projection math (coast, scenarios,
   * levels, «+X meses»). = `config.expectedRealReturn` when the override is set;
   * = `effectiveRealReturn` otherwise (N3, #515). Required by construction.
   */
  readonly realReturnUsed: number;
  /**
   * Weighted real return from the eligible tier mix — Σ(tier_weight × tier_return)
   * over the eligible pool (N3, #515). The rate before any manual override.
   */
  readonly effectiveRealReturn: number;
  /** Eligible assets net of goal reservations (minor units); projection/levels start here. */
  readonly eligibleMinor: number;
  /** Eligible assets BEFORE goal reservation (minor units); `goalFireDelay` needs this. */
  readonly eligibleGrossMinor: number;
  /** The FIRE target (minor units) — `12 × monthlySpending / safeWithdrawalRate`. */
  readonly fireNumberMinor: number;
}

/** `calculateFireForScope`'s result: a `FireResult` that always carries its `FireContext`. */
export interface ScopeFireResult extends FireResult {
  readonly context: FireContext;
}

/**
 * The explicit what-if override: a copy of `context` with a different resolved
 * rate. This is the ONLY way the rate changes downstream — a caller that wants a
 * different rate must say so here, it can never happen by forgetting to thread it.
 */
export function withRate(context: FireContext, realReturnUsed: number): FireContext {
  return { ...context, realReturnUsed };
}

/**
 * The single projection door (#1122). Every FIRE trajectory — the dashboard
 * chart, the level rail, the goal-delay probes and the contribution what-if —
 * runs through here, so the rate, FIRE number and reference age always come from
 * the `FireContext` (#1026) and can never diverge from coast/levels. The scalar
 * engine (`projectFire`) and the contribution-plan engine
 * (`projectFireWithContributionPlan`) are internal dispatch targets, not caller
 * choices.
 *
 * Defaults come from the context: `startingEligibleMinor` → its net-eligible
 * total, `fireNumberMinor` → its FIRE number, age → its config. Override
 * `startingEligibleMinor` for a what-if starting balance, or `fireNumberMinor`
 * to project a trajectory tall enough to cross a higher target (the level rail
 * projects to Fat). Passing `plan` + `growthAssumption` switches to the
 * contribution-plan what-if (ADR 0041); otherwise it is the scalar projection.
 */
export interface ProjectFireFromContextInput {
  /** Monthly contribution (minor units) for the scalar projection; ignored in plan mode. */
  monthlyContributionMinor?: number;
  /** Override the starting eligible balance; defaults to the context's net-eligible total. */
  startingEligibleMinor?: number;
  /** Override the FIRE target; defaults to the context's FIRE number. */
  fireNumberMinor?: number;
  maxYears?: number;
  /**
   * Contribution-plan what-if (ADR 0041). When set together with
   * `growthAssumption`, the door dispatches to `projectFireWithContributionPlan`;
   * `monthlyContributionMinor` is then unused (the plan stream drives contributions).
   */
  plan?: ContributionPlan;
  growthAssumption?: FireGrowthAssumption;
  /** Plan mode: per-bucket fallback annual return; defaults to the context rate. */
  assumedAnnualReturn?: number;
  /** Plan mode: pre-resolved annual returns per holding id (#547). */
  holdingAnnualReturnById?: Record<string, number>;
  /** Plan mode: optional split of today's eligible assets across holdings. */
  startingEligibleByHoldingId?: Record<string, number>;
  /** Plan mode: unit prices for pricing units-denominated contributions. */
  unitPriceMajorByHoldingId?: Record<string, string>;
  /** Plan mode: today (ISO YYYY-MM-DD). Required when `plan` is set. */
  todayISO?: string;
}

export function projectFireFromContext(
  context: FireContext,
  input: ProjectFireFromContextInput,
): FireProjection {
  const startingEligibleMinor = input.startingEligibleMinor ?? context.eligibleMinor;
  const fireNumberMinor = input.fireNumberMinor ?? context.fireNumberMinor;
  const currentAge = context.config.currentAge;

  if (input.plan !== undefined && input.growthAssumption !== undefined) {
    return projectFireWithContributionPlan({
      startingEligibleMinor,
      expectedRealReturn: context.realReturnUsed,
      fireNumberMinor,
      todayISO: input.todayISO ?? new Date().toISOString().slice(0, 10),
      plan: input.plan,
      growthAssumption: input.growthAssumption,
      assumedAnnualReturn: input.assumedAnnualReturn ?? context.realReturnUsed,
      ...(input.holdingAnnualReturnById === undefined
        ? {}
        : { holdingAnnualReturnById: input.holdingAnnualReturnById }),
      ...(input.startingEligibleByHoldingId === undefined
        ? {}
        : { startingEligibleByHoldingId: input.startingEligibleByHoldingId }),
      ...(input.unitPriceMajorByHoldingId === undefined
        ? {}
        : { unitPriceMajorByHoldingId: input.unitPriceMajorByHoldingId }),
      ...(currentAge === undefined ? {} : { currentAge }),
      ...(input.maxYears === undefined ? {} : { maxYears: input.maxYears }),
    });
  }

  return projectFire({
    startingEligibleMinor,
    monthlyContributionMinor: input.monthlyContributionMinor ?? 0,
    expectedRealReturn: context.realReturnUsed,
    fireNumberMinor,
    ...(currentAge === undefined ? {} : { currentAge }),
    ...(input.maxYears === undefined ? {} : { maxYears: input.maxYears }),
  });
}

export function isFireEligibleAsset(
  asset: Pick<ManualAsset, "id" | "isPrimaryResidence">,
  config: Pick<FireScopeConfig, "excludedAssetIds">,
): boolean {
  return !asset.isPrimaryResidence && !(config.excludedAssetIds ?? []).includes(asset.id);
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
    const growthFactor = rate > -1 ? Math.pow(1 + rate, yearsToRetirement) : NaN;

    if (Number.isFinite(growthFactor) && growthFactor > 0) {
      const coastFireRequiredMinor = Math.round(fireNumberMinor / growthFactor);

      result.coastFireRequired = money(coastFireRequiredMinor, currency);
      result.isAlreadyAtCoastFire = eligibleAssetsMinor >= coastFireRequiredMinor;
    }

    if (rate > 0 && eligibleAssetsMinor > 0 && fireNumberMinor > eligibleAssetsMinor) {
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
): ScopeFireResult {
  // The risk-bearing pool assembly lives in its own tested module (#1122).
  const pool = assembleFireEligiblePool({
    config,
    assets,
    liabilities,
    workspace,
    scopeId,
  });
  const { excludedAssets, netEligibleMinor, eligibleByTierMinor } = pool;

  // N3 (#515): compute effective weighted rate, then resolve the single rate to use.
  const effective = effectiveRealReturn({
    eligibleByTierMinor,
    ...(config.tierRealReturns ? { tierRealReturns: config.tierRealReturns } : {}),
  });
  const realReturnUsed = config.expectedRealReturn ?? effective;

  const reserved = Math.max(0, Math.min(reservedForGoalsMinor, netEligibleMinor));
  const eligibleAfterReservation = netEligibleMinor - reserved;

  const base = calculateFire(
    config,
    eligibleAfterReservation,
    workspace.baseCurrency,
    realReturnUsed,
  );

  const context: FireContext = {
    config,
    currency: workspace.baseCurrency,
    realReturnUsed,
    effectiveRealReturn: effective,
    eligibleMinor: eligibleAfterReservation,
    eligibleGrossMinor: netEligibleMinor,
    fireNumberMinor: base.fireNumber.amountMinor,
  };

  return {
    ...base,
    excludedAssets,
    reservedForGoals: money(reserved, workspace.baseCurrency),
    context,
  };
}
