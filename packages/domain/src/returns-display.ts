import type { CostBasisGrade } from "./cost-basis-grade";
import { VALUE_ONLY_PNL_NOTICE } from "./cost-basis-grade";
import type { DecimalString } from "./decimal";
import type { AssetClassResolution, ExposureCoverage } from "./exposure-lookthrough";
import type { Instrument } from "./instrument-catalog";
import type { InvestmentOperation } from "./investment-types";
import { deriveInvestmentValuation } from "./investment-valuation";
import type { CurrencyCode, MoneyMinor } from "./money";
import type {
  DatedPayout,
  IrrResult,
  MonthlyCloseValue,
  SimpleGain,
  TwrResult,
} from "./returns";
import { holdingIrr, holdingTwr, simpleGain } from "./returns";
import type { AssetClassReturnsHolding } from "./returns-by-class";
import { returnsByAssetClass } from "./returns-by-class";
import type { SubsetReturnsSlice } from "./returns-subset";
import { subsetReturns } from "./returns-subset";

/**
 * Presentation-selection layer for investment returns (#551, ADR 0040). Turns the
 * pure engine measures (`simpleGain`, `holdingIrr`, …) into the display model a
 * surface renders: WHICH measures apply for a holding, whether the span is
 * annualized, the realized/unrealized split, and the honest caveats. It never
 * computes a figure the net-worth math reads — returns are present-time, derived
 * (ADR 0040) — and keeps all the branching pure so the dashboard just calls it.
 */

/** How a holding's return is framed: a market instrument (three measures) or an
 *  appreciating non-market asset (a single revalorización vs cost). */
export type ReturnsKind = "market" | "appreciating";

/** Instruments that trade on a market: money- and time-weighted returns apply. */
const MARKET_INSTRUMENTS: ReadonlySet<Instrument> = new Set([
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
  "crypto",
  "precious_metal",
]);

/** Assets that revalue but do not trade: only a simple gain vs cost is honest —
 *  an IRR/TWR would be forced there (ADR 0040, #562). */
const APPRECIATING_INSTRUMENTS: ReadonlySet<Instrument> = new Set([
  "property",
  "vehicle",
  "coin_collection",
]);

/**
 * The returns framing for an instrument, or null when returns do not apply
 * (cash, deposits, debts): those hold no gain to speak of.
 */
export function returnsKindForInstrument(instrument: Instrument): ReturnsKind | null {
  if (MARKET_INSTRUMENTS.has(instrument)) {
    return "market";
  }
  if (APPRECIATING_INSTRUMENTS.has(instrument)) {
    return "appreciating";
  }
  return null;
}

export const MARKET_CAVEAT = "No incluye dividendos ni cupones.";
/**
 * Shown instead of {@link MARKET_CAVEAT} once the holding has recorded payouts
 * (#657): distributions now enter the money-weighted return and realized simple
 * gain, but TWR still tracks price only — honest about which measures moved.
 */
export const MARKET_PAYOUTS_CAVEAT =
  "IRR y ganancia simple incluyen los cobros registrados; la TWR, no.";
export const APPRECIATING_CAVEAT =
  "Revalorización = valor actual − coste. Sin IRR ni TWR de mercado.";

/** The display model for a holding's (or the portfolio's) returns. */
export interface HoldingReturnsView {
  kind: ReturnsKind;
  /** realized + unrealized total gain, in money. */
  totalGain: MoneyMinor;
  /** totalGain / total invested, or null when nothing was invested. */
  totalReturnRatio: number | null;
  /** whether the span reached a year, so an annual figure is meaningful. */
  annualized: boolean;
  /** compound annual growth rate, only when annualized; null otherwise. */
  cagr: number | null;
  /** money-weighted IRR (market only; null for appreciating), reason preserved. */
  irr: IrrResult | null;
  /** time-weighted return (market only; null for appreciating or missing history). */
  twr: TwrResult | null;
  /** realized P/L split (market only; null otherwise). */
  realizedPnl: MoneyMinor | null;
  /**
   * unrealized P/L split (market only; null otherwise) — and null as well when
   * the cost it would be measured against was never declared (#1505): a
   * «P/L latente 0,00 €» is not a limit to caveat, it is a claim that the
   * position has neither gained nor lost, which is exactly what nobody knows.
   */
  unrealizedPnl: MoneyMinor | null;
  /** honest limits surfaced, never buried (ADR 0040). */
  caveats: string[];
  /**
   * How honest the cost these measures are built on is (#1505), straight off
   * `PositionSummary`. Null when every contribution is a real movement.
   */
  costBasisGrade: CostBasisGrade | null;
}

function fromSimpleGain(
  gain: SimpleGain,
): Pick<HoldingReturnsView, "totalGain" | "totalReturnRatio" | "annualized" | "cagr"> {
  return {
    annualized: gain.annualized,
    cagr: gain.cagr,
    totalGain: gain.totalGain,
    totalReturnRatio: gain.totalReturnRatio,
  };
}

function marketView(
  gain: SimpleGain,
  irr: IrrResult,
  twr: TwrResult | null,
  split: {
    realizedPnl?: MoneyMinor;
    unrealizedPnl?: MoneyMinor;
    costBasisGrade?: CostBasisGrade;
  },
  payoutsIncluded = false,
): HoldingReturnsView {
  // A cost nobody declared withholds the latent figure and says so out loud
  // (#1505). The realized split stays: it is proceeds against that same cost, but
  // it only exists once units have actually been SOLD, and a sale is a real
  // movement whose euros are not in dispute — the caveat covers what it inherits.
  const valueOnly = split.costBasisGrade === "value_only";
  return {
    kind: "market",
    ...fromSimpleGain(gain),
    caveats: [
      payoutsIncluded ? MARKET_PAYOUTS_CAVEAT : MARKET_CAVEAT,
      ...(valueOnly ? [VALUE_ONLY_PNL_NOTICE] : []),
    ],
    costBasisGrade: split.costBasisGrade ?? null,
    irr,
    realizedPnl: split.realizedPnl ?? null,
    twr,
    unrealizedPnl: valueOnly ? null : (split.unrealizedPnl ?? null),
  };
}

/**
 * One holding's annual return for forward projection (#558 what-if): prefers the
 * #547 display measures in TWR → IRR → CAGR order, then the caller's assumed rate.
 */
export function resolveHoldingAnnualReturnForProjection(
  view: HoldingReturnsView | null | undefined,
  assumedAnnualReturn: number,
): number {
  if (view === null || view === undefined) {
    return assumedAnnualReturn;
  }
  if (view.twr?.annualizedRate !== null && view.twr?.annualizedRate !== undefined) {
    return view.twr.annualizedRate;
  }
  if (view.irr?.rate !== null && view.irr?.rate !== undefined) {
    return view.irr.rate;
  }
  if (view.annualized && view.cagr !== null) {
    return view.cagr;
  }
  return assumedAnnualReturn;
}

/** Inputs for one holding's display model: instrument + already-computed measures. */
export interface HoldingReturnsViewInput {
  instrument: Instrument;
  simpleGain: SimpleGain;
  irr: IrrResult;
  twr?: TwrResult | null;
  realizedPnl?: MoneyMinor;
  unrealizedPnl?: MoneyMinor;
  /** The grade of the cost the measures rest on (#1505) — see `PositionSummary`. */
  costBasisGrade?: CostBasisGrade;
  /** Whether recorded payouts fed the measures, switching the honest caveat (#657). */
  payoutsIncluded?: boolean;
}

/**
 * Build a holding's returns display model, or null when returns do not apply.
 * Market instruments get all three measures + the realized/unrealized split;
 * appreciating assets get only the simple gain (IRR/TWR would be forced there).
 */
export function buildHoldingReturnsView(
  input: HoldingReturnsViewInput,
): HoldingReturnsView | null {
  const kind = returnsKindForInstrument(input.instrument);
  if (kind === null) {
    return null;
  }
  if (kind === "appreciating") {
    return {
      kind,
      ...fromSimpleGain(input.simpleGain),
      caveats: [APPRECIATING_CAVEAT],
      // An appreciating asset holds no operation ledger to grade: its cost is the
      // acquisition anchor, and #1441 is where THAT question lives.
      costBasisGrade: null,
      irr: null,
      realizedPnl: null,
      twr: null,
      unrealizedPnl: null,
    };
  }
  return marketView(
    input.simpleGain,
    input.irr,
    input.twr ?? null,
    {
      ...(input.costBasisGrade === undefined
        ? {}
        : { costBasisGrade: input.costBasisGrade }),
      ...(input.realizedPnl ? { realizedPnl: input.realizedPnl } : {}),
      ...(input.unrealizedPnl ? { unrealizedPnl: input.unrealizedPnl } : {}),
    },
    input.payoutsIncluded ?? false,
  );
}

/**
 * The portfolio's returns display model: always a market view (the three
 * measures), since the portfolio blends its market holdings' cashflows.
 */
export function buildPortfolioReturnsView(
  gain: SimpleGain,
  irr: IrrResult,
  twr: TwrResult | null = null,
  payoutsIncluded = false,
): HoldingReturnsView {
  return marketView(gain, irr, twr, {}, payoutsIncluded);
}

/** The raw per-asset reads the returns computation folds through the engine. */
export interface InvestmentReturnsContext {
  operationsByAsset: ReadonlyMap<string, readonly InvestmentOperation[]>;
  cachedPriceByAsset: ReadonlyMap<string, DecimalString | undefined>;
  manualPriceByAsset: ReadonlyMap<string, DecimalString | undefined>;
  monthlyClosesByAsset?: ReadonlyMap<string, readonly MonthlyCloseValue[]>;
  /** Recorded payouts (one-offs + derived occurrences) per asset id (#657). */
  payoutsByAsset?: ReadonlyMap<string, readonly DatedPayout[]>;
  currency: CurrencyCode;
  valuationDate: string;
}

/**
 * A holding's valuation, through the SAME authority the net-worth math uses
 * (`deriveInvestmentValuation`, ADR 0006): units × price when a price is known,
 * the cost basis when none is. Valuing an unpriced holding at 0 fabricated a
 * −100% simple gain on any alta whose first quote had not landed yet, right
 * beside the row the valuation was already showing at cost (#1314).
 *
 * The whole valuation, not just its `valueMinor`: it also carries how honest the
 * cost that value is measured against is (#1505), and the two must come from one
 * call so a caveat can never be about a different fold than the figure (#1422).
 */
function holdingValuation(
  assetId: string,
  operations: readonly InvestmentOperation[],
  ctx: InvestmentReturnsContext,
) {
  return deriveInvestmentValuation({
    assetId,
    cachedPrice: ctx.cachedPriceByAsset.get(assetId),
    currency: ctx.currency,
    manualPrice: ctx.manualPriceByAsset.get(assetId),
    operations: [...operations],
  });
}

/**
 * One holding's contribution to a subset, read off the shared context: its value
 * through the net-worth authority, its monthly-close series and its payouts. Both
 * subset callers below — the whole book and the per-class decomposition — take
 * their slices from here, so neither can drift on WHICH of the three inputs it
 * remembers to pass.
 */
function subsetSliceOf(
  ctx: InvestmentReturnsContext,
  assetId: string,
  operations: readonly InvestmentOperation[],
): SubsetReturnsSlice {
  return {
    marketValueMinor: holdingValuation(assetId, operations, ctx).valueMinor,
    monthlyCloses: ctx.monthlyClosesByAsset?.get(assetId) ?? [],
    operations,
    payouts: ctx.payoutsByAsset?.get(assetId) ?? [],
  };
}

/**
 * Per-holding returns for every operation-bearing investment, keyed by asset id.
 * Folds each holding's operations + current market value through the engine, then
 * frames the result by instrument. Holdings with no operations are skipped (a
 * stored/mirrored holding — precious metal, connected source — carries none).
 */
export function investmentReturnsById(
  ctx: InvestmentReturnsContext & {
    instrumentByAsset: ReadonlyMap<string, Instrument>;
  },
): Map<string, HoldingReturnsView> {
  const views = new Map<string, HoldingReturnsView>();

  for (const [assetId, operations] of ctx.operationsByAsset) {
    if (operations.length === 0) {
      continue;
    }
    const instrument = ctx.instrumentByAsset.get(assetId);
    if (instrument === undefined) {
      continue;
    }
    const valuation = holdingValuation(assetId, operations, ctx);
    const monthlyCloses = ctx.monthlyClosesByAsset?.get(assetId);
    const payouts = ctx.payoutsByAsset?.get(assetId) ?? [];
    const returnsInput = {
      currency: ctx.currency,
      marketValueMinor: valuation.valueMinor,
      operations,
      payouts,
      valuationDate: ctx.valuationDate,
    };
    const view = buildHoldingReturnsView({
      instrument,
      irr: holdingIrr(returnsInput),
      payoutsIncluded: payouts.length > 0,
      simpleGain: simpleGain(returnsInput),
      twr: monthlyCloses ? holdingTwr({ monthlyCloses, operations }) : null,
      // The grade comes from the SAME valuation the market value came from
      // (#1505, #1422): the caveat must be about the figure on screen.
      ...(valuation.costBasisGrade === undefined
        ? {}
        : { costBasisGrade: valuation.costBasisGrade }),
    });
    if (view !== null) {
      views.set(assetId, view);
    }
  }

  return views;
}

/**
 * The returns view over every operation-bearing investment — the /patrimonio
 * hero's «Rentabilidad … · IRR …» line. Null when there are no operation-bearing
 * holdings: a book that never bought anything has no return to report.
 *
 * The whole book is just another SUBSET of holdings, so it rides the same engine
 * the managed portfolio (#1552) and the per-class decomposition (#552) do
 * (`subsetReturns`, ADR 0040's #1592/#1593 amendment). What died with the merge it
 * replaces: each half of an internal traspaso counted as a flow, so a book that
 * received nothing from outside read as if it had been funded twice, and the hero
 * could disagree with the cartera card about the very same money (#1422).
 *
 * This function owns only WHICH holdings are measured and on what basis — every
 * one it can see, whole (never ownership-scoped): a fund's return is the same
 * figure whoever owns which share. Value and monthly closes are gross to match.
 *
 * The TWR stays null when the caller passes no per-holding series at all, exactly
 * as `investmentReturnsById` does: "this surface did not ask for a TWR" is not the
 * same statement as "there are not enough closes to measure one", and only the
 * second deserves a reason on screen.
 */
export function portfolioReturnsView(
  ctx: InvestmentReturnsContext,
): HoldingReturnsView | null {
  const slices: SubsetReturnsSlice[] = [];
  for (const [assetId, operations] of ctx.operationsByAsset) {
    if (operations.length === 0) {
      continue;
    }
    slices.push(subsetSliceOf(ctx, assetId, operations));
  }

  if (slices.length === 0) {
    return null;
  }

  const returns = subsetReturns({
    currency: ctx.currency,
    slices,
    valuationDate: ctx.valuationDate,
  });
  return buildPortfolioReturnsView(
    returns.simpleGain,
    returns.irr,
    ctx.monthlyClosesByAsset === undefined ? null : returns.twr,
    returns.payoutsIncluded,
  );
}

/**
 * The class attribution uses present-time exposure-profile weights over the whole
 * history (the profile is a present-time lens, never frozen — ADR 0039); declared,
 * not hidden.
 */
export const CLASS_ATTRIBUTION_CAVEAT =
  "Reparto por clase con los pesos actuales del perfil de exposición (no históricos).";

/**
 * Why a class shows value and weight but no return (#1458): every euro it holds
 * is a sleeve inside a mixed product, so the three measures would be that
 * product's result wearing this class's name — the reader's «¿qué sentido tiene
 * que el efectivo rinda un 10%?» has no answer because the figure was never the
 * cash's. There are no per-sleeve return series inside a mixed fund and there
 * will not be, so this is not a gap to close: the class holds nothing of its own
 * to measure, and the honest figure is the blank one.
 */
export const ATTRIBUTED_ONLY_NOTICE =
  "Ni un euro de esta clase está en un producto suyo: todo su valor es una fracción de productos mixtos, así que la rentabilidad sería la de esos productos, no la de la clase.";

/** One asset class's display model plus the market value attributed to it. */
export interface AssetClassReturnsView {
  key: string;
  value: MoneyMinor;
  view: HoldingReturnsView;
  /** No value attributed today: the class is history, not present weight (#1456). */
  closed: boolean;
  /** The part of `value` held in products wholly of this class (#1458). */
  measuredValue: MoneyMinor;
  /**
   * Every euro of this class is a sleeve of a mixed product (#1458), so `view`
   * carries no rate: the ratio, CAGR, IRR and TWR are null and
   * {@link ATTRIBUTED_ONLY_NOTICE} says why. Value and weight survive — those are
   * a split of money, which the attribution genuinely knows.
   */
  attributedOnly: boolean;
}

/** The per-asset-class returns display model: one entry per class + coverage. */
export interface AssetClassReturnsViewResult {
  classes: AssetClassReturnsView[];
  coverage: ExposureCoverage;
}

/**
 * The rates a class with nothing of its own does not get to print (#1458). This
 * is a SELECTION, the job of this layer — the engine still emits every measure,
 * so a caller that wants the mixed products' blended figure can still read it
 * off `returnsByAssetClass`. What dies here is the surface's ability to print
 * it under the class's name. The money — `totalGain`, the attributed `value` —
 * stays: splitting euros by weight is what the attribution actually knows.
 */
const withheldMeasures = {
  cagr: null,
  irr: null,
  totalReturnRatio: null,
  twr: null,
} as const;

/**
 * Per-asset-class returns for the dashboard (#552, ADR 0040 fast-follow): folds
 * every operation-bearing MARKET holding — with its resolved asset class — through
 * the pure `returnsByAssetClass` engine, then frames each class as a portfolio
 * market view (the three measures) carrying the honest class-attribution caveat.
 * Present-time and unscoped, mirroring `portfolioReturnsView`; null when no such
 * holding resolves. Appreciating assets (property/vehicle/coins) are excluded — an
 * IRR/TWR would be forced there — so the classes decompose the market portfolio,
 * not gross assets.
 */
export function returnsByAssetClassView(
  ctx: InvestmentReturnsContext & {
    instrumentByAsset: ReadonlyMap<string, Instrument>;
    assetClassByAsset: ReadonlyMap<string, AssetClassResolution>;
  },
): AssetClassReturnsViewResult | null {
  const holdings: AssetClassReturnsHolding[] = [];
  for (const [assetId, operations] of ctx.operationsByAsset) {
    if (operations.length === 0) {
      continue;
    }
    const instrument = ctx.instrumentByAsset.get(assetId);
    if (instrument === undefined || returnsKindForInstrument(instrument) !== "market") {
      continue;
    }
    holdings.push({
      ...subsetSliceOf(ctx, assetId, operations),
      assetClass: ctx.assetClassByAsset.get(assetId) ?? { kind: "unknown" },
    });
  }

  if (holdings.length === 0) {
    return null;
  }

  const result = returnsByAssetClass({
    currency: ctx.currency,
    holdings,
    valuationDate: ctx.valuationDate,
  });

  return {
    classes: result.classes.map((entry) => {
      const view = buildPortfolioReturnsView(
        entry.simpleGain,
        entry.irr,
        entry.twr,
        entry.payoutsIncluded,
      );
      return {
        attributedOnly: entry.attributedOnly,
        closed: entry.closed,
        key: entry.key,
        measuredValue: entry.measuredValue,
        value: entry.value,
        view: {
          ...view,
          ...(entry.attributedOnly ? withheldMeasures : {}),
          caveats: [
            ...view.caveats,
            CLASS_ATTRIBUTION_CAVEAT,
            ...(entry.attributedOnly ? [ATTRIBUTED_ONLY_NOTICE] : []),
          ],
        },
      };
    }),
    coverage: result.coverage,
  };
}
