import type { ContributionPlan } from "./contribution-plan";
import type { FireCapitalSplit } from "./fire-capital-split";
import { fireDrawsFromTier, splitFireCapital } from "./fire-capital-split";
import { assembleFireEligiblePool, type FireExcludedAsset } from "./fire-eligible-pool";
import type { FireGrowthAssumption } from "./fire-plan-projection";
import { projectFireWithContributionPlan } from "./fire-plan-projection";
import type { FireProjection } from "./fire-projection";
import {
  type FireProjectionFamily,
  projectFire,
  projectFireFamily,
} from "./fire-projection";
import type { FireRentReturnReport } from "./fire-rent-return";
import { deriveRentRealReturns, scopedNetRentAnnualMinor } from "./fire-rent-return";
import type { FireRetirementPlan } from "./fire-retirement-profile";
import type { FireReturnMix } from "./fire-return";
import { fireReturnMix } from "./fire-return";
import type { LiquidityTier } from "./liquidity-ladder";
import type { CurrencyCode, MoneyMinor } from "./money";
import { money } from "./money";
import type { PayoutSchedule } from "./payouts";
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
   * Declared monthly savings capacity in minor units (PRD #421, #425): the ONLY
   * contribution the FIRE projection assumes (#1416, ADR 0074). Read through
   * `monthlySavingsCapacityForFire`, never off this field directly. Optional —
   * when unset the UI offers a suggestion from operations history
   * (`suggestMonthlySavingsCapacity`) but never writes it implicitly; the
   * projection reads `undefined` as 0.
   */
  monthlySavingsCapacityMinor?: number;
  /**
   * True when the one-shot #1416 migration wrote `monthlySavingsCapacityMinor` for a
   * workspace that had been projecting its contribution plan's total instead of a
   * declared figure. The value is that same total — preserved, never invented — and
   * this flag's only job is to let the assumptions form say "we put this here,
   * check it" rather than have the number appear from nowhere. Cleared by the first save of the FIRE
   * form: `saveFireConfig` replaces the scope object, and by then the user has seen
   * the note. Never set outside that migration.
   */
  monthlySavingsCapacitySeededFromPlan?: boolean;
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
  /**
   * Does the immobilized side of the pool — non-primary property, collections —
   * count as FIRE capital? (#1460, ADR 0078.)
   *
   * A declaration, not a dogma: #1447 showed the two natures apart, and for a user
   * who does not plan to sell the flat the honest measure is that the brick does not
   * count at all. Read through `fireCountsImmobilizedCapital`, never off this field:
   * `undefined` means `true`, which is what every config stored before this existed
   * meant, so nobody's figures moved when the field appeared.
   */
  immobilizedCountsAsFireCapital?: boolean;
  /**
   * La declaración del usuario sobre su propio plan (#1428, ADR 0081): `"ordinary"`
   * = jubilación ordinaria, `"early"` = FIRE. `undefined` = no ha contestado, y ese
   * es el único estado en el que la pantalla se atreve a OFRECER el cambio.
   *
   * Existe porque autodetectar el perfil de alguien y decirle «tú no vas a hacer
   * FIRE» sienta fatal cuando la detección se equivoca: las señales proponen, la
   * declaración decide, y se puede volver atrás desde el mismo formulario. No toca
   * ninguna cifra del motor — solo qué pregunta lidera la pantalla.
   */
  retirementPlan?: FireRetirementPlan;
  /**
   * La edad a partir de la cual jubilarse ya no es *early* (#1428). Dato del usuario
   * con defecto neutro 65, nunca normativa en el código: la edad ordinaria depende
   * del país y del año, y codificar la española aquí sería la misma trampa que
   * codificar el tope de aportación (#1427). Se lee por
   * `ordinaryRetirementAgeForFire`.
   */
  ordinaryRetirementAge?: number;
  /**
   * La **edad final**: hasta qué edad tiene que durar el capital, si el usuario quiere
   * esa versión del gasto sostenible (#1428). Opcional y sin defecto aplicado: sin este
   * campo la tarjeta enseña solo la versión perpetua (`vendible × tasa de retirada`).
   *
   * No se llama «esperanza de vida» a propósito: eso sería una tabla actuarial, y
   * worthline no tiene ninguna ni la va a estimar. Es una edad que el usuario declara,
   * como todo lo demás aquí (ADR 0074). El motor FIRE es SWR puro y la duración viaja
   * dentro de la elección de la tasa; este es el único sitio donde hay que decirla en
   * voz alta.
   */
  capitalLastsUntilAge?: number;
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
  /**
   * La edad a la que el capital de hoy llegaría al número FIRE **completo si el usuario
   * dejara de aportar ahora mismo** (#1425, ADR 0079). Se llamaba `coastFireAge`, y ese nombre
   * prometía «la edad a la que llegas a Coast», que es otra pregunta y otra cifra
   * (`fireCoastArrival`): esta asume aportación CERO y por eso contradecía en silencio
   * la premisa del `coastFireRequired` de al lado, calculado contra la edad objetivo.
   *
   * La cifra es honesta y barata — «si dejo de ahorrar, ¿qué pasa?» — pero solo se
   * puede leer con su premisa delante, así que el nombre la lleva dentro. Ausente
   * cuando el retorno no compone (≤ 0), no hay capital, o ya se supera el número FIRE.
   */
  fireAgeIfContributionsStop?: number;
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
  /**
   * `eligibleAssets` split into what can be sold in slices and what cannot
   * (#1447). Its `drawableMinor` IS `eligibleAssets`: with the brick counting, that
   * is both sides added up; with the user declaring it out (#1460) it is the sellable
   * side alone and the immobilized row is patrimonio shown beside the figure rather
   * than inside it. Absent on `calculateFire`, which only sees a pre-computed total
   * with no tier mix.
   */
  readonly capitalSplit: FireCapitalSplit;
  /**
   * What the declared rents did to the rate (#1448): the properties whose net
   * yield replaced the housing rung's guess, and the rents that were left out with
   * the reason. Both empty when no schedule was handed in — the rate is then the
   * pure tier weighting it always was.
   */
  readonly rentReturns: FireRentReturnReport;
  /**
   * The slices behind `context.effectiveRealReturn` (#1426): each rung's weight and
   * rate, and each own-rate asset's. It is the SAME computation the rate came from
   * (`fireReturnMix`), not a re-derivation, so a screen can print «26,6 % mercado
   * al 5 %» knowing the rows add back up to the rate above them. Rows are empty for
   * an empty pool, and the whole mix describes the *effective* rate — a config with
   * a manual `expectedRealReturn` overrides that rate, and a caller showing the
   * table must say so or hide it.
   */
  readonly returnMix: FireReturnMix;
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

/**
 * One growth loop, two views (#1537): the chart sliced to the regular FIRE
 * number and the rail grown to `horizonTargetMinor` (Fat). Scalar only — plan
 * mode is the contribution what-if, not the /objetivos family.
 */
export function projectFireFamilyFromContext(
  context: FireContext,
  input: ProjectFireFromContextInput & { horizonTargetMinor: number },
): FireProjectionFamily {
  const startingEligibleMinor = input.startingEligibleMinor ?? context.eligibleMinor;
  const fireNumberMinor = input.fireNumberMinor ?? context.fireNumberMinor;
  const currentAge = context.config.currentAge;

  return projectFireFamily({
    expectedRealReturn: context.realReturnUsed,
    fireNumberMinor,
    horizonTargetMinor: input.horizonTargetMinor,
    monthlyContributionMinor: input.monthlyContributionMinor ?? 0,
    startingEligibleMinor,
    ...(currentAge === undefined ? {} : { currentAge }),
    ...(input.maxYears === undefined ? {} : { maxYears: input.maxYears }),
  });
}

/**
 * Whether the scope's expected real return was fixed by hand instead of weighted from
 * the tier mix (#1426). One door, because three surfaces ask the same question — the
 * rent-substitution disclosure (#1448), the weighting table and the assumptions row —
 * and a predicate written three times is three chances to disagree about what «manual»
 * means.
 */
export function isManualFireReturn(
  config: Pick<FireScopeConfig, "expectedRealReturn">,
): boolean {
  return config.expectedRealReturn !== undefined;
}

/**
 * Whether the scope counts its immobilized capital as FIRE capital (#1460). The one
 * door for the declaration, so «no está declarado» resolves to the default in exactly
 * one place — the engine, the form's checkbox and the split's grey row all ask here.
 */
export function fireCountsImmobilizedCapital(
  config: Pick<FireScopeConfig, "immobilizedCountsAsFireCapital">,
): boolean {
  return config.immobilizedCountsAsFireCapital !== false;
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
 * caller controls the rate — el Coast requerido y `fireAgeIfContributionsStop`
 * salen de este único valor.
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

    // Coast solo existe si queda margen de composición antes de la edad objetivo
    // (#1425, ADR 0079): `growthFactor > 1`. Con retorno ≤ 0, o con la edad objetivo
    // ya pasada, el «requisito» sale IGUAL o MAYOR que el número FIRE, y entonces la
    // frase que lo acompaña —«alcanza esa cifra y el interés compuesto hace el
    // resto»— es falsa: no hay resto que hacer. Antes esa cifra se imprimía igual, y
    // en cuanto #1425 le puso fecha la incoherencia se volvió literal («llegas a
    // Coast tres años DESPUÉS de llegar a FIRE» para cualquiera de 65+ que no haya
    // tocado su edad objetivo, que por defecto es 65). Se suprime el bloque entero
    // —requisito, sello y llegada— en una sola puerta, así que el tick de la barra,
    // el panel, el agent view y el sello de logro desaparecen juntos o no.
    if (Number.isFinite(growthFactor) && growthFactor > 1) {
      const coastFireRequiredMinor = Math.round(fireNumberMinor / growthFactor);

      result.coastFireRequired = money(coastFireRequiredMinor, currency);
      result.isAlreadyAtCoastFire = eligibleAssetsMinor >= coastFireRequiredMinor;
    }

    // Aportación CERO por construcción (de ahí el nombre, #1425): el número FIRE
    // completo descontado al capital de hoy, sin un euro más. La edad a la que se
    // llega a Coast aportando vive en `fireCoastArrival`, que proyecta la trayectoria.
    if (rate > 0 && eligibleAssetsMinor > 0 && fireNumberMinor > eligibleAssetsMinor) {
      result.fireAgeIfContributionsStop =
        config.currentAge +
        Math.log(fireNumberMinor / eligibleAssetsMinor) / Math.log(1 + rate);
    }
  }

  return result;
}

/**
 * The evidence `calculateFireForScope` reads beyond the holdings themselves. One
 * door for the rent-derived rate (#1448): a caller hands in the declared payout
 * schedules it already has, and the substitution happens HERE — so the home, the
 * /objetivos panel, the figure explanations and the MCP tools cannot end up
 * quoting different rates for the same scope.
 */
export interface CalculateFireForScopeOptions {
  /**
   * Every declared payout schedule (all holdings). When omitted, no rate is derived
   * and the tier defaults stand exactly as before.
   */
  payoutSchedules?: readonly PayoutSchedule[];
  /**
   * Today (YYYY-MM-DD) — what a schedule's validity window is measured against.
   * Defaults to the system date; pass the page's own "today" so the rate is
   * measured on the same clock as everything else on screen.
   */
  todayISO?: string;
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
  options: CalculateFireForScopeOptions = {},
): ScopeFireResult {
  // A rented property's own net yield replaces its rung's guess (#1448). Derived
  // over ALL assets: the pool below is what filters this to the ones the scope
  // owns and FIRE counts, so eligibility is decided in exactly one place.
  //
  // No schedules, no derivation and no clock: the system-date fallback exists only
  // for a caller that hands in schedules without a date, and it must not put a
  // second, disagreeing clock in front of a computation that has nothing to date.
  const payoutSchedules = options.payoutSchedules ?? [];
  const rentRealReturns =
    payoutSchedules.length === 0
      ? { byAssetId: new Map(), notices: [] }
      : deriveRentRealReturns({
          assets,
          baseCurrency: workspace.baseCurrency,
          schedules: payoutSchedules,
          todayISO: options.todayISO ?? new Date().toISOString().slice(0, 10),
        });

  // The risk-bearing pool assembly lives in its own tested module (#1122).
  const pool = assembleFireEligiblePool({
    config,
    assets,
    liabilities,
    rentRealReturns,
    workspace,
    scopeId,
  });
  const { excludedAssets, eligibleByTierMinor, scopedDebtByTierMinor } = pool;

  // The user's declaration about brick (#1460, ADR 0078). #1447 showed the two
  // natures apart; whoever does not plan to sell the flat can declare that it is not
  // FIRE capital at all, and then the immobilized rungs leave the pool AND the
  // weighting. Both, through the same predicate: dropping the capital while keeping
  // its weight would quote a rate nobody's money holds — and it is the housing rung
  // that drags the rate down, so forgetting the second half would make the result
  // MORE pessimistic than what the user declared, not less.
  const countsImmobilized = fireCountsImmobilizedCapital(config);
  const drawableByTierMinor: Partial<Record<LiquidityTier, number>> = {};
  for (const [tier, amountMinor] of Object.entries(eligibleByTierMinor) as [
    LiquidityTier,
    number,
  ][]) {
    if (fireDrawsFromTier(tier, countsImmobilized)) {
      drawableByTierMinor[tier] = amountMinor;
    }
  }
  // A rented flat's own rate (#1448) rides its rung: out of the pool, out of the rate.
  const ratedOverrides = pool.assetRateOverrides.filter((override) =>
    fireDrawsFromTier(override.tier, countsImmobilized),
  );

  // The split is where the reservation is clamped and where the figure FIRE measures
  // comes from, so the rows on screen and `eligibleAssets` are the same arithmetic
  // and not two readings of it (#1447, #1460).
  const capitalSplit = splitFireCapital({
    countsImmobilized,
    debtByTierMinor: scopedDebtByTierMinor,
    eligibleByTierMinor,
    reservedForGoalsMinor,
  });
  const reserved =
    capitalSplit.sellable.reservedMinor + capitalSplit.immobilized.reservedMinor;
  const eligibleAfterReservation = capitalSplit.drawableMinor;

  // N3 (#515): compute effective weighted rate, then resolve the single rate to use.
  // A per-asset rate substitutes its tier's over its own slice (#1448) — it is not
  // an extra weight, so the eligible total the rate describes is unchanged.
  // The mix, not just the scalar (#1426): the rate travels with the weights it was
  // computed from, so the screen that prints «de dónde sale el 3,50 %» reads the
  // same arithmetic instead of repeating it.
  const returnMix = fireReturnMix({
    assetLabelById: Object.fromEntries(
      [...rentRealReturns.byAssetId].map(([assetId, derived]) => [
        assetId,
        derived.assetName,
      ]),
    ),
    assetRateOverrides: ratedOverrides,
    eligibleByTierMinor: drawableByTierMinor,
    ...(config.tierRealReturns ? { tierRealReturns: config.tierRealReturns } : {}),
  });
  const effective = returnMix.rate;
  const realReturnUsed = config.expectedRealReturn ?? effective;

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
    // Gross of RESERVATION, not of debt — and of the same pool the figure came from,
    // so a scope that leaves its brick out does not hand `goalFireDelay` a capital
    // the FIRE number never counted.
    eligibleGrossMinor: eligibleAfterReservation + reserved,
    fireNumberMinor: base.fireNumber.amountMinor,
  };

  return {
    ...base,
    excludedAssets,
    reservedForGoals: money(reserved, workspace.baseCurrency),
    context,
    capitalSplit,
    returnMix,
    rentReturns: {
      // La renta neta que el ámbito posee (#1428): se saca de TODOS los overrides que
      // el pool derivó, no solo de los que la tasa acabó usando. Un piso declarado
      // fuera del capital FIRE (#1460) deja de mover la rentabilidad esperada y sigue
      // pagando su alquiler todos los meses, así que su renta no puede desaparecer del
      // gasto sostenible por una declaración que habla de capital.
      netRentAnnualMinor: scopedNetRentAnnualMinor(
        pool.assetRateOverrides,
        rentRealReturns,
      ),
      // The overrides the pool kept ARE the rates that took effect, so the report
      // cannot advertise a substitution the rate did not receive.
      applied: ratedOverrides.flatMap((override) => {
        const derived = rentRealReturns.byAssetId.get(override.assetId);
        // The override's amount IS the scoped weight the rate was applied with, so
        // the report cannot disagree with the arithmetic about how much it counted.
        return derived ? [{ ...derived, scopedValueMinor: override.amountMinor }] : [];
      }),
      // A rate the pool derived for a rung FIRE no longer draws from did not take
      // effect, so it cannot be reported as applied — and it cannot vanish either:
      // the user declared that rent and deserves to be told why it is not moving the
      // number (#1448's guard, under #1460's declaration).
      notices: [
        ...pool.rentReturnNotices,
        ...pool.assetRateOverrides
          .filter((override) => !fireDrawsFromTier(override.tier, countsImmobilized))
          .flatMap((override) => {
            const derived = rentRealReturns.byAssetId.get(override.assetId);
            return derived
              ? [
                  {
                    assetId: override.assetId,
                    assetName: derived.assetName,
                    grossRate: null,
                    reason: "immobilized_not_counted" as const,
                  },
                ]
              : [];
          }),
      ],
    },
  };
}
