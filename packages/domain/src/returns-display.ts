import type { DecimalString } from "./decimal";
import type { AssetClassResolution, ExposureCoverage } from "./exposure-lookthrough";
import type { Instrument } from "./instrument-catalog";
import type { InvestmentOperation } from "./investment-types";
import { selectInvestmentPrice } from "./investment-valuation";
import type { CurrencyCode, MoneyMinor } from "./money";
import { derivePosition } from "./positions";
import type {
  IrrResult,
  MonthlyCloseValue,
  PortfolioHolding,
  SimpleGain,
  TwrResult,
} from "./returns";
import {
  holdingIrr,
  holdingTwr,
  portfolioIrr,
  portfolioSimpleGain,
  portfolioTwr,
  simpleGain,
} from "./returns";
import type { AssetClassReturnsHolding } from "./returns-by-class";
import { returnsByAssetClass } from "./returns-by-class";

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
  /** unrealized P/L split (market only; null otherwise). */
  unrealizedPnl: MoneyMinor | null;
  /** honest limits surfaced, never buried (ADR 0040). */
  caveats: string[];
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
  split: { realizedPnl?: MoneyMinor; unrealizedPnl?: MoneyMinor },
): HoldingReturnsView {
  return {
    kind: "market",
    ...fromSimpleGain(gain),
    caveats: [MARKET_CAVEAT],
    irr,
    realizedPnl: split.realizedPnl ?? null,
    twr,
    unrealizedPnl: split.unrealizedPnl ?? null,
  };
}

/** Inputs for one holding's display model: instrument + already-computed measures. */
export interface HoldingReturnsViewInput {
  instrument: Instrument;
  simpleGain: SimpleGain;
  irr: IrrResult;
  twr?: TwrResult | null;
  realizedPnl?: MoneyMinor;
  unrealizedPnl?: MoneyMinor;
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
      irr: null,
      realizedPnl: null,
      twr: null,
      unrealizedPnl: null,
    };
  }
  return marketView(input.simpleGain, input.irr, input.twr ?? null, {
    ...(input.realizedPnl ? { realizedPnl: input.realizedPnl } : {}),
    ...(input.unrealizedPnl ? { unrealizedPnl: input.unrealizedPnl } : {}),
  });
}

/**
 * The portfolio's returns display model: always a market view (the three
 * measures), since the portfolio blends its market holdings' cashflows.
 */
export function buildPortfolioReturnsView(
  gain: SimpleGain,
  irr: IrrResult,
  twr: TwrResult | null = null,
): HoldingReturnsView {
  return marketView(gain, irr, twr, {});
}

/** The raw per-asset reads the returns computation folds through the engine. */
export interface InvestmentReturnsContext {
  operationsByAsset: ReadonlyMap<string, readonly InvestmentOperation[]>;
  cachedPriceByAsset: ReadonlyMap<string, DecimalString | undefined>;
  manualPriceByAsset: ReadonlyMap<string, DecimalString | undefined>;
  monthlyClosesByAsset?: ReadonlyMap<string, readonly MonthlyCloseValue[]>;
  portfolioMonthlyCloses?: readonly MonthlyCloseValue[];
  currency: CurrencyCode;
  valuationDate: string;
}

/** A holding's operations paired with the current market value (0 when unpriced). */
function holdingMarketValueMinor(
  assetId: string,
  operations: readonly InvestmentOperation[],
  ctx: InvestmentReturnsContext,
): number {
  const price = selectInvestmentPrice({
    cachedPrice: ctx.cachedPriceByAsset.get(assetId),
    manualPrice: ctx.manualPriceByAsset.get(assetId),
  });
  const position = derivePosition([...operations], {
    assetId,
    currency: ctx.currency,
    ...(price ? { currentPricePerUnit: price.pricePerUnit } : {}),
  });
  return position.marketValue?.amountMinor ?? 0;
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
    const marketValueMinor = holdingMarketValueMinor(assetId, operations, ctx);
    const monthlyCloses = ctx.monthlyClosesByAsset?.get(assetId);
    const returnsInput = {
      currency: ctx.currency,
      marketValueMinor,
      operations,
      valuationDate: ctx.valuationDate,
    };
    const view = buildHoldingReturnsView({
      instrument,
      irr: holdingIrr(returnsInput),
      simpleGain: simpleGain(returnsInput),
      twr: monthlyCloses ? holdingTwr({ monthlyCloses, operations }) : null,
    });
    if (view !== null) {
      views.set(assetId, view);
    }
  }

  return views;
}

/**
 * The portfolio returns view over every operation-bearing investment: merges the
 * holdings' cashflows into one dated stream (portfolio IRR) and sums the simple
 * gains. Null when there are no operation-bearing holdings.
 */
export function portfolioReturnsView(
  ctx: InvestmentReturnsContext,
): HoldingReturnsView | null {
  const holdings: PortfolioHolding[] = [];
  for (const [assetId, operations] of ctx.operationsByAsset) {
    if (operations.length === 0) {
      continue;
    }
    holdings.push({
      marketValueMinor: holdingMarketValueMinor(assetId, operations, ctx),
      operations,
    });
  }

  if (holdings.length === 0) {
    return null;
  }

  const input = {
    currency: ctx.currency,
    holdings,
    valuationDate: ctx.valuationDate,
  };
  return buildPortfolioReturnsView(
    portfolioSimpleGain(input),
    portfolioIrr(input),
    ctx.portfolioMonthlyCloses
      ? portfolioTwr({
          holdings,
          monthlyCloses: ctx.portfolioMonthlyCloses,
        })
      : null,
  );
}

/**
 * The class attribution uses present-time exposure-profile weights over the whole
 * history (the profile is a present-time lens, never frozen — ADR 0039); declared,
 * not hidden.
 */
export const CLASS_ATTRIBUTION_CAVEAT =
  "Reparto por clase con los pesos actuales del perfil de exposición (no históricos).";

/** One asset class's display model plus the market value attributed to it. */
export interface AssetClassReturnsView {
  key: string;
  value: MoneyMinor;
  view: HoldingReturnsView;
}

/** The per-asset-class returns display model: one entry per class + coverage. */
export interface AssetClassReturnsViewResult {
  classes: AssetClassReturnsView[];
  coverage: ExposureCoverage;
}

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
      assetClass: ctx.assetClassByAsset.get(assetId) ?? { kind: "unknown" },
      marketValueMinor: holdingMarketValueMinor(assetId, operations, ctx),
      monthlyCloses: ctx.monthlyClosesByAsset?.get(assetId) ?? [],
      operations,
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
      const view = buildPortfolioReturnsView(entry.simpleGain, entry.irr, entry.twr);
      return {
        key: entry.key,
        value: entry.value,
        view: { ...view, caveats: [...view.caveats, CLASS_ATTRIBUTION_CAVEAT] },
      };
    }),
    coverage: result.coverage,
  };
}
