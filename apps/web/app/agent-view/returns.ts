import type { AgentViewReadStore } from "@worthline/db";
import type {
  AssetClassResolution,
  AssetClassReturns,
  CurrencyCode,
  ExposureCoverage,
  Instrument,
  InvestmentOperation,
  MonthlyCloseSnapshotRow,
  MonthlyCloseValue,
  TwrCashflow,
} from "@worthline/domain";
import {
  allocateByBps,
  daysBetween,
  derivePosition,
  monthlyCloseValuesFromSnapshotRows,
  operationCashflows,
  operationTwrCashflows,
  returnsByAssetClass,
  returnsKindForInstrument,
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
  const monthlyCloses = monthlyCloseValuesFromSnapshotRows(
    await input.store.readSnapshotHoldings({
      holdingId: input.assetId,
      kind: "asset",
      scopeId: input.snapshotScopeId,
    }),
  );

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
  scopeId: string;
  valuationDate: string;
}): Promise<AgentViewReturns | null> {
  const cashflows = [];
  const twrCashflows: TwrCashflow[] = [];
  let firstDate: string | null = null;
  let marketValueMinor = 0;

  const operationBearingIds = new Set<string>();
  const classHoldings: {
    id: string;
    operations: readonly InvestmentOperation[];
    marketValueMinor: number;
    ownershipBps: number;
    assetClass: AssetClassResolution;
  }[] = [];
  for (const holding of input.holdings) {
    if (returnsKindForInstrument(holding.instrument) !== "market") {
      continue;
    }

    const operations = await input.store.readOperations(holding.id);
    if (operations.length === 0) {
      continue;
    }

    operationBearingIds.add(holding.id);
    marketValueMinor += holding.currentValueMinor;
    firstDate = earliest(firstDate, firstOperationDate(operations));

    cashflows.push(
      ...operationCashflows(operations).map((flow) => ({
        ...flow,
        amountMinor: allocateByBps(flow.amountMinor, holding.totalShareBps),
      })),
    );
    twrCashflows.push(
      ...operationTwrCashflows(operations).map((flow) => ({
        ...flow,
        amountMinor: allocateByBps(flow.amountMinor, holding.totalShareBps),
      })),
    );

    if (holding.assetClass) {
      classHoldings.push({
        assetClass: holding.assetClass,
        id: holding.id,
        marketValueMinor: holding.currentValueMinor,
        operations,
        ownershipBps: holding.totalShareBps,
      });
    }
  }

  if (operationBearingIds.size === 0) {
    return null;
  }

  const snapshotRows = await input.store.readSnapshotHoldings({
    scopeId: input.scopeId,
  });

  const base = buildReturnsFromCashflows({
    cashflows,
    currency: input.currency,
    firstOperationDate: firstDate,
    marketValueMinor,
    monthlyCloses: monthlyPortfolioCloses(snapshotRows, operationBearingIds),
    twrCashflows,
    valuationDate: input.valuationDate,
  });

  const byAssetClass = buildAssetClassReturnsBlock({
    currency: input.currency,
    holdings: classHoldings,
    snapshotRows,
    valuationDate: input.valuationDate,
  });

  return byAssetClass ? { ...base, byAssetClass } : base;
}

/**
 * The per-asset-class decomposition of the portfolio returns (PRD #552): resolves
 * each operation-bearing market holding's monthly-close series, then folds the
 * holdings — with their resolved class and ownership share — through the pure
 * `returnsByAssetClass` engine. Ownership-scoped (`ownershipBps` = the holding's
 * `totalShareBps`, its value the scoped `ownedMinor`), the SAME basis as the
 * portfolio block above and `exposure.byAssetClass`, so the three reconcile. Null
 * when no holding carries a resolved class, so the block is only added when present.
 */
function buildAssetClassReturnsBlock(input: {
  currency: CurrencyCode;
  holdings: {
    id: string;
    operations: readonly InvestmentOperation[];
    marketValueMinor: number;
    ownershipBps: number;
    assetClass: AssetClassResolution;
  }[];
  snapshotRows: Awaited<ReturnType<AgentViewReadStore["readSnapshotHoldings"]>>;
  valuationDate: string;
}): AgentViewAssetClassReturnsBlock | null {
  if (input.holdings.length === 0) {
    return null;
  }

  const closesByHolding = monthlyClosesByHolding(
    input.snapshotRows,
    new Set(input.holdings.map((holding) => holding.id)),
  );

  const result = returnsByAssetClass({
    currency: input.currency,
    holdings: input.holdings.map((holding) => ({
      assetClass: holding.assetClass,
      marketValueMinor: holding.marketValueMinor,
      monthlyCloses: closesByHolding.get(holding.id) ?? [],
      operations: holding.operations,
      ownershipBps: holding.ownershipBps,
    })),
    valuationDate: input.valuationDate,
  });

  return {
    classes: result.classes.map(toAssetClassReturns),
    coverage: toExposureCoverage(result.coverage),
  };
}

function toAssetClassReturns(entry: AssetClassReturns): AgentViewAssetClassReturns {
  return {
    key: entry.key,
    moneyWeighted: toMoneyWeighted(entry.irr),
    simple: simpleGainToReturn(entry.simpleGain, entry.value.currency),
    timeWeighted: toTimeWeighted(entry.twr),
    value: moneyOf(entry.value.amountMinor, entry.value.currency),
  };
}

function simpleGainToReturn(
  gain: AssetClassReturns["simpleGain"],
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

function toExposureCoverage(coverage: ExposureCoverage): AgentViewExposureCoverage {
  return {
    classified: moneyOf(coverage.classified.amountMinor, coverage.classified.currency),
    notApplicable: moneyOf(
      coverage.notApplicable.amountMinor,
      coverage.notApplicable.currency,
    ),
    unknown: moneyOf(coverage.unknown.amountMinor, coverage.unknown.currency),
  };
}

function monthlyClosesByHolding(
  rows: Awaited<ReturnType<AgentViewReadStore["readSnapshotHoldings"]>>,
  holdingIds: Set<string>,
): Map<string, MonthlyCloseValue[]> {
  const byHolding = new Map<string, MonthlyCloseSnapshotRow[]>();
  for (const row of rows) {
    if (row.kind !== "asset" || !holdingIds.has(row.holdingId)) {
      continue;
    }
    const list = byHolding.get(row.holdingId) ?? [];
    list.push({
      dateKey: row.dateKey,
      snapshotId: row.snapshotId,
      valueMinor: row.valueMinor,
    });
    byHolding.set(row.holdingId, list);
  }

  const closes = new Map<string, MonthlyCloseValue[]>();
  for (const [holdingId, list] of byHolding) {
    closes.set(holdingId, monthlyCloseValuesFromSnapshotRows(list));
  }
  return closes;
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

function monthlyPortfolioCloses(
  rows: Awaited<ReturnType<AgentViewReadStore["readSnapshotHoldings"]>>,
  holdingIds: Set<string>,
): MonthlyCloseValue[] {
  const totals = new Map<
    string,
    { dateKey: string; snapshotId: string; valueMinor: number }
  >();

  for (const row of rows) {
    if (row.kind !== "asset" || !holdingIds.has(row.holdingId)) {
      continue;
    }
    const existing = totals.get(row.snapshotId);
    if (existing) {
      existing.valueMinor += row.valueMinor;
    } else {
      totals.set(row.snapshotId, {
        dateKey: row.dateKey,
        snapshotId: row.snapshotId,
        valueMinor: row.valueMinor,
      });
    }
  }

  return monthlyCloseValuesFromSnapshotRows([...totals.values()]);
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

function qualitySignals(
  firstOperationDate: string | null,
  twrStartDate: string | null,
): AgentViewReturnQualitySignal[] {
  return [
    {
      code: "DISTRIBUTIONS_NOT_CAPTURED",
      label:
        "Dividendos, cupones y distribuciones no están modelados; los retornos pueden infravalorar fondos de distribución.",
      severity: "low",
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

function moneyOf(amountMinor: number, currency: CurrencyCode): AgentViewMoney {
  return { amountMinor, currency };
}
