import type { AgentViewReadStore } from "@worthline/db";
import type {
  AssetClassResolution,
  AssetClassReturns,
  CurrencyCode,
  DatedPayout,
  ExposureCoverage,
  Instrument,
  InvestmentOperation,
  MonthlyCloseValue,
  ReferenceDataUnavailableReason,
  SimpleGain,
  SubsetReturnsSlice,
  TwrCashflow,
} from "@worthline/domain";
import {
  daysBetween,
  derivePosition,
  monthlyCloseValuesByHolding,
  operationCashflows,
  operationTwrCashflows,
  returnsByAssetClass,
  returnsKindForInstrument,
  subsetReturns,
  timeWeightedReturn,
  xirr,
} from "@worthline/domain";

import type {
  AgentViewAssetClassReturns,
  AgentViewAssetClassReturnsBlock,
  AgentViewExposureCoverage,
  AgentViewMoney,
  AgentViewMoneyWeightedReturn,
  AgentViewReturnQualitySignal,
  AgentViewReturns,
  AgentViewSimpleReturn,
  AgentViewTimeWeightedReturn,
} from "./contract";
import { moneyOf } from "./money";

const YEAR_DAYS = 365;

export async function buildHoldingReturns(input: {
  store: AgentViewReadStore;
  assetId: string;
  currency: CurrencyCode;
  currentValueMinor: number;
  instrument: Instrument;
  operations: readonly InvestmentOperation[];
  snapshotScopeId: string;
  valuationDate: string;
}): Promise<AgentViewReturns | null> {
  if (returnsKindForInstrument(input.instrument) !== "market") {
    return null;
  }

  if (input.operations.length === 0) {
    return null;
  }

  const position = derivePosition([...input.operations], {
    assetId: input.assetId,
    currency: input.currency,
  });
  const monthlyCloses =
    monthlyCloseValuesByHolding(
      await input.store.readSnapshotHoldings({
        holdingId: input.assetId,
        kind: "asset",
        scopeId: input.snapshotScopeId,
      }),
    ).get(input.assetId) ?? [];

  return buildReturnsFromCashflows({
    cashflows: operationCashflows(input.operations),
    currency: input.currency,
    firstOperationDate: firstOperationDate(input.operations),
    marketValueMinor: input.currentValueMinor,
    monthlyCloses,
    realizedGainMinor: position.realizedPnl.amountMinor,
    twrCashflows: operationTwrCashflows(input.operations),
    unrealizedGainMinor: input.currentValueMinor - position.costBasis.amountMinor,
    valuationDate: input.valuationDate,
  });
}

/**
 * The portfolio's returns for the agent view (#550) — measured by `subsetReturns`,
 * the SAME engine the hero (#1592), the cartera gestionada (#1552, ADR 0085) and
 * the per-class decomposition (#552) ride. The agent view answers the owner's
 * question about the very same book the board shows; two engines for one question
 * is exactly how two surfaces end up disagreeing about the same money (#1422).
 *
 * What it owns is WHICH holdings are measured and on what basis, never a rate:
 *
 * - **Market instruments with a ledger only.** An appreciating asset (property,
 *   coins) holds no IRR/TWR (ADR 0040), and a stored/mirrored holding carries no
 *   operations to derive one from — neither fabricates a figure.
 * - **Ownership-scoped**, `ownershipBps` = the holding's `totalShareBps` with its
 *   value the scoped `ownedMinor`: the same basis as `exposure.byAssetClass` and
 *   the per-class block below, so the three reconcile. On a whole-owned book that
 *   is the hero's unscoped figure to the cent.
 * - **The ledger and the payouts arrive from the caller** (`buildFinancialContext`
 *   read them once for the whole context): a read per holding inside this fold was
 *   N queries for a figure that is one fold, and the holdings block could quote a
 *   ledger this one had re-read.
 *
 * The engine owns the rest: an internal traspaso pair nets to its residual instead
 * of inflating the invested (ADR 0082), recorded payouts enter the simple gain and
 * the IRR (#657), and the monthly closes align by calendar month rather than by
 * snapshot id — the sawtooth of #1457.
 */
export async function buildPortfolioReturns(input: {
  store: AgentViewReadStore;
  currency: CurrencyCode;
  holdings: {
    id: string;
    currentValueMinor: number;
    instrument: Instrument;
    totalShareBps: number;
    /** The holding's resolved asset class, for the per-class block (PRD #552). */
    assetClass?: AssetClassResolution;
  }[];
  /**
   * Every investment ledger of the workspace, keyed by holding id — read ONCE by
   * the caller and shared with the holdings block, so no two blocks of one context
   * can fold a different ledger.
   */
  operationsByHoldingId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /** Recorded payouts up to the valuation date, keyed by holding id (#657). */
  payoutsByHoldingId: ReadonlyMap<string, readonly DatedPayout[]>;
  scopeId: string;
  valuationDate: string;
  /** Set when the global exposure catalog could not be read (PRD #711 S3). */
  catalogUnavailable?: ReferenceDataUnavailableReason;
}): Promise<AgentViewReturns | null> {
  const measured: MeasuredHolding[] = [];
  let firstDate: string | null = null;

  for (const holding of input.holdings) {
    if (returnsKindForInstrument(holding.instrument) !== "market") {
      continue;
    }
    const operations = input.operationsByHoldingId.get(holding.id) ?? [];
    if (operations.length === 0) {
      continue;
    }
    firstDate = earliest(firstDate, firstOperationDate(operations));
    const payouts = input.payoutsByHoldingId.get(holding.id);
    measured.push({
      id: holding.id,
      marketValueMinor: holding.currentValueMinor,
      operations,
      ownershipBps: holding.totalShareBps,
      ...(holding.assetClass === undefined ? {} : { assetClass: holding.assetClass }),
      ...(payouts === undefined ? {} : { payouts }),
    });
  }

  if (measured.length === 0) {
    return null;
  }

  // The frozen rows the monthly closes come from: parent asset rows of this scope
  // only. The per-position children (ADR 0035) belong to no holding the fold
  // measures, so the second indexed read they cost is skipped (#1235).
  const closesByHolding = monthlyCloseValuesByHolding(
    await input.store.readSnapshotHoldings({
      includePositions: false,
      kind: "asset",
      scopeId: input.scopeId,
    }),
    new Set(measured.map((holding) => holding.id)),
  );
  const sliceOf = (holding: MeasuredHolding): SubsetReturnsSlice => ({
    marketValueMinor: holding.marketValueMinor,
    monthlyCloses: closesByHolding.get(holding.id) ?? [],
    operations: holding.operations,
    ownershipBps: holding.ownershipBps,
    ...(holding.payouts === undefined ? {} : { payouts: holding.payouts }),
  });

  const returns = subsetReturns({
    currency: input.currency,
    slices: measured.map(sliceOf),
    valuationDate: input.valuationDate,
  });

  const byAssetClass = buildAssetClassReturnsBlock({
    closesByHolding,
    currency: input.currency,
    holdings: measured,
    valuationDate: input.valuationDate,
    ...(input.catalogUnavailable === undefined
      ? {}
      : { catalogUnavailable: input.catalogUnavailable }),
  });

  const base: AgentViewReturns = {
    moneyWeighted: toMoneyWeighted(returns.irr),
    qualitySignals: qualitySignals(
      firstDate,
      returns.twr.startDate,
      returns.payoutsIncluded,
    ),
    simple: simpleGainToReturn(returns.simpleGain, input.currency),
    timeWeighted: toTimeWeighted(returns.twr),
  };

  return byAssetClass ? { ...base, byAssetClass } : base;
}

/** One holding the portfolio fold measures: its ledger, its value, its weights. */
interface MeasuredHolding {
  id: string;
  operations: readonly InvestmentOperation[];
  /** Ownership-scoped value today (`ownedMinor`), the basis the closes are on. */
  marketValueMinor: number;
  ownershipBps: number;
  payouts?: readonly DatedPayout[];
  assetClass?: AssetClassResolution;
}

/**
 * The per-asset-class decomposition of the portfolio returns (PRD #552): folds the
 * measured holdings that carry a resolved class — with their ownership share, their
 * closes and their payouts — through the pure `returnsByAssetClass` engine, which
 * rides the same `subsetReturns` the block above does. Ownership-scoped
 * (`ownershipBps` = the holding's `totalShareBps`, its value the scoped
 * `ownedMinor`), the SAME basis as the portfolio block and `exposure.byAssetClass`,
 * so the three reconcile. Null when no holding carries a resolved class, so the
 * block is only added when present.
 */
function buildAssetClassReturnsBlock(input: {
  currency: CurrencyCode;
  holdings: readonly MeasuredHolding[];
  closesByHolding: ReadonlyMap<string, readonly MonthlyCloseValue[]>;
  valuationDate: string;
  catalogUnavailable?: ReferenceDataUnavailableReason;
}): AgentViewAssetClassReturnsBlock | null {
  const classified = input.holdings.filter(
    (holding): holding is MeasuredHolding & { assetClass: AssetClassResolution } =>
      holding.assetClass !== undefined,
  );
  if (classified.length === 0) {
    return null;
  }

  const result = returnsByAssetClass({
    currency: input.currency,
    holdings: classified.map((holding) => ({
      assetClass: holding.assetClass,
      marketValueMinor: holding.marketValueMinor,
      monthlyCloses: input.closesByHolding.get(holding.id) ?? [],
      operations: holding.operations,
      ownershipBps: holding.ownershipBps,
      ...(holding.payouts === undefined ? {} : { payouts: holding.payouts }),
    })),
    valuationDate: input.valuationDate,
  });

  return {
    classes: result.classes.map(toAssetClassReturns),
    coverage: toExposureCoverage(result.coverage, input.catalogUnavailable),
  };
}

function toAssetClassReturns(entry: AssetClassReturns): AgentViewAssetClassReturns {
  return {
    // Present only when true, like every other state flag on the agent view: an
    // absent `closed` reads as a live class, never as an unknown one.
    ...(entry.closed ? { closed: true as const } : {}),
    key: entry.key,
    moneyWeighted: toMoneyWeighted(entry.irr),
    simple: simpleGainToReturn(entry.simpleGain, entry.value.currency),
    timeWeighted: toTimeWeighted(entry.twr),
    value: moneyOf(entry.value.amountMinor, entry.value.currency),
  };
}

/** A domain `SimpleGain` as the agent view prints it — decimals as strings. */
function simpleGainToReturn(
  gain: SimpleGain,
  currency: CurrencyCode,
): AgentViewSimpleReturn {
  return {
    annualized: gain.annualized,
    cagr: gain.cagr === null ? null : gain.cagr.toString(),
    totalGain: moneyOf(gain.totalGain.amountMinor, currency),
    totalInvested: moneyOf(gain.totalInvestedMinor, currency),
    totalReturnRatio:
      gain.totalReturnRatio === null ? null : gain.totalReturnRatio.toString(),
  };
}

function toExposureCoverage(
  coverage: ExposureCoverage,
  catalogUnavailable?: ReferenceDataUnavailableReason,
): AgentViewExposureCoverage {
  return {
    classified: moneyOf(coverage.classified.amountMinor, coverage.classified.currency),
    notApplicable: moneyOf(
      coverage.notApplicable.amountMinor,
      coverage.notApplicable.currency,
    ),
    unknown: moneyOf(coverage.unknown.amountMinor, coverage.unknown.currency),
    ...(catalogUnavailable === undefined ? {} : { catalogUnavailable }),
  };
}

function buildReturnsFromCashflows(input: {
  cashflows: { date: string; amountMinor: number }[];
  currency: CurrencyCode;
  firstOperationDate: string | null;
  marketValueMinor: number;
  monthlyCloses: MonthlyCloseValue[];
  realizedGainMinor?: number;
  twrCashflows: TwrCashflow[];
  unrealizedGainMinor?: number;
  valuationDate: string;
}): AgentViewReturns {
  const twr = timeWeightedReturn({
    cashflows: input.twrCashflows,
    monthlyCloses: input.monthlyCloses,
  });

  return {
    moneyWeighted: toMoneyWeighted(
      xirr([
        ...input.cashflows,
        ...(input.marketValueMinor > 0
          ? [{ amountMinor: input.marketValueMinor, date: input.valuationDate }]
          : []),
      ]),
    ),
    qualitySignals: qualitySignals(input.firstOperationDate, twr.startDate),
    simple: simpleReturn(input),
    timeWeighted: toTimeWeighted(twr),
  };
}

function simpleReturn(input: {
  cashflows: { date: string; amountMinor: number }[];
  currency: CurrencyCode;
  firstOperationDate: string | null;
  marketValueMinor: number;
  realizedGainMinor?: number;
  unrealizedGainMinor?: number;
  valuationDate: string;
}): AgentViewSimpleReturn {
  const totalInvestedMinor = input.cashflows.reduce(
    (sum, flow) => (flow.amountMinor < 0 ? sum - flow.amountMinor : sum),
    0,
  );
  const proceedsMinor = input.cashflows.reduce(
    (sum, flow) => (flow.amountMinor > 0 ? sum + flow.amountMinor : sum),
    0,
  );
  const totalGainMinor = proceedsMinor + input.marketValueMinor - totalInvestedMinor;
  const ratio =
    totalInvestedMinor > 0 ? (totalGainMinor / totalInvestedMinor).toString() : null;
  const spanDays = input.firstOperationDate
    ? daysBetween(input.firstOperationDate, input.valuationDate)
    : 0;
  const annualized = spanDays >= YEAR_DAYS;
  const cagr =
    annualized && ratio !== null
      ? ((1 + Number(ratio)) ** (YEAR_DAYS / spanDays) - 1).toString()
      : null;

  return {
    annualized,
    cagr,
    totalGain: moneyOf(totalGainMinor, input.currency),
    totalInvested: moneyOf(totalInvestedMinor, input.currency),
    totalReturnRatio: ratio,
    ...(input.realizedGainMinor === undefined
      ? {}
      : { realizedGain: moneyOf(input.realizedGainMinor, input.currency) }),
    ...(input.unrealizedGainMinor === undefined
      ? {}
      : { unrealizedGain: moneyOf(input.unrealizedGainMinor, input.currency) }),
  };
}

function toMoneyWeighted(result: {
  rate: number | null;
  reason: AgentViewMoneyWeightedReturn["reason"];
}): AgentViewMoneyWeightedReturn {
  return {
    rate: result.rate === null ? null : result.rate.toString(),
    reason: result.reason,
  };
}

function toTimeWeighted(result: {
  annualized: boolean;
  annualizedRate: number | null;
  endDate: string | null;
  rate: number | null;
  reason: AgentViewTimeWeightedReturn["reason"];
  startDate: string | null;
}): AgentViewTimeWeightedReturn {
  return {
    annualized: result.annualized,
    annualizedRate:
      result.annualizedRate === null ? null : result.annualizedRate.toString(),
    endDate: result.endDate,
    rate: result.rate === null ? null : result.rate.toString(),
    reason: result.reason,
    startDate: result.startDate,
  };
}

/**
 * The honest limits of the measures, never buried (ADR 0040).
 *
 * The distributions signal is the one that MOVES: a fold that got recorded payouts
 * cannot keep saying they are not modelled — they are in the simple gain and the
 * IRR, and only the TWR still tracks price alone (#657). Same split the board's
 * caveat declares (`MARKET_PAYOUTS_CAVEAT`), so the agent reads what the owner reads.
 */
function qualitySignals(
  firstOperationDate: string | null,
  twrStartDate: string | null,
  payoutsIncluded = false,
): AgentViewReturnQualitySignal[] {
  return [
    payoutsIncluded
      ? {
          code: "DISTRIBUTIONS_NOT_IN_TWR" as const,
          label:
            "La ganancia simple y el IRR incluyen los cobros registrados (dividendos, cupones, alquiler); la TWR mide solo precio.",
          severity: "low" as const,
        }
      : {
          code: "DISTRIBUTIONS_NOT_CAPTURED" as const,
          label:
            "Dividendos, cupones y distribuciones no están modelados; los retornos pueden infravalorar fondos de distribución.",
          severity: "low" as const,
        },
    ...(firstOperationDate && twrStartDate && twrStartDate > firstOperationDate
      ? [
          {
            code: "TWR_STARTS_AFTER_FIRST_OPERATION" as const,
            firstOperationDate,
            label:
              "El TWR empieza en el primer cierre mensual disponible, posterior a la primera operación.",
            severity: "low" as const,
            twrStartDate,
          },
        ]
      : []),
  ];
}

function firstOperationDate(operations: readonly InvestmentOperation[]): string | null {
  return operations.reduce<string | null>(
    (first, operation) => earliest(first, operation.executedAt.slice(0, 10)),
    null,
  );
}

function earliest(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return right < left ? right : left;
}
