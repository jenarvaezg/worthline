/**
 * Pure assembly for /historico's "Origen del cambio" chart (#653 S1, #660 S2).
 * Builds the monthly-close breakdown series and stacked-chart geometry from
 * frozen snapshots, holding rows, operations, and recorded payouts.
 */

import type { SnapshotHoldingRecord } from "@worthline/db";
import type {
  DebtModel,
  DeltaBreakdownBandId,
  DeltaBreakdownPeriod,
  InvestmentOperation,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  OwnershipShare,
  SnapshotHoldingRow,
  StackedChartGeometry,
  ValuationMethod,
  Workspace,
} from "@worthline/domain";
import {
  buildMonthlyCloseBreakdownSeries,
  buildStackedChartGeometry,
  collectHoldingPayouts,
  resolveScopeMemberIds,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "@worthline/domain";

export interface HistoricoBreakdownView {
  periods: DeltaBreakdownPeriod[];
  geometry: StackedChartGeometry<DeltaBreakdownBandId> | null;
  /** True when any computable period has a non-zero payout band (#660). */
  showsPayoutBand: boolean;
}

export interface BuildHistoricoBreakdownInput {
  workspace: Workspace;
  scopeId: string;
  snapshots: readonly NetWorthSnapshot[];
  holdingRecords: readonly SnapshotHoldingRecord[];
  assets: readonly ManualAsset[];
  liabilities: readonly Liability[];
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>;
  operationsByHoldingId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  payoutRecords: Parameters<typeof collectHoldingPayouts>[0];
  payoutSchedules: Parameters<typeof collectHoldingPayouts>[1];
  today: string;
}

function valuationMethodByHoldingId(
  assets: readonly ManualAsset[],
  liabilities: readonly Liability[],
  debtModelByLiabilityId: ReadonlyMap<string, DebtModel | null>,
): Map<string, ValuationMethod> {
  const methods = new Map<string, ValuationMethod>();
  for (const asset of assets) {
    methods.set(asset.id, valuationMethodOfAsset(asset));
  }
  for (const liability of liabilities) {
    methods.set(
      liability.id,
      valuationMethodOfLiability(debtModelByLiabilityId.get(liability.id) ?? null),
    );
  }
  return methods;
}

function ownershipByHoldingId(
  assets: readonly ManualAsset[],
  liabilities: readonly Liability[],
): Map<string, readonly OwnershipShare[]> {
  const ownership = new Map<string, readonly OwnershipShare[]>();
  for (const asset of assets) {
    ownership.set(asset.id, asset.ownership);
  }
  for (const liability of liabilities) {
    ownership.set(liability.id, liability.ownership);
  }
  return ownership;
}

function holdingRowsBySnapshotId(
  holdingRecords: readonly SnapshotHoldingRecord[],
): Map<string, readonly SnapshotHoldingRow[]> {
  const bySnapshot = new Map<string, SnapshotHoldingRow[]>();
  for (const record of holdingRecords) {
    const list = bySnapshot.get(record.snapshotId);
    if (list) list.push(record);
    else bySnapshot.set(record.snapshotId, [record]);
  }
  return bySnapshot;
}

export function buildHistoricoBreakdownView(
  input: BuildHistoricoBreakdownInput,
): HistoricoBreakdownView {
  const scopeMemberIds = new Set(resolveScopeMemberIds(input.workspace, input.scopeId));
  const payoutsByHolding = collectHoldingPayouts(
    input.payoutRecords,
    input.payoutSchedules,
    input.today,
  );

  const periods = buildMonthlyCloseBreakdownSeries({
    holdingRowsBySnapshotId: holdingRowsBySnapshotId(input.holdingRecords),
    operationsByHoldingId: input.operationsByHoldingId,
    ownershipByHoldingId: ownershipByHoldingId(input.assets, input.liabilities),
    payoutsByHolding,
    scopeMemberIds,
    snapshots: input.snapshots,
    today: input.today,
    valuationMethodByHoldingId: valuationMethodByHoldingId(
      input.assets,
      input.liabilities,
      input.debtModelByLiabilityId,
    ),
  });

  const completePeriods = periods.filter((period) => period.bands !== null);
  const showsPayoutBand = completePeriods.some(
    (period) => (period.bands?.payoutsMinor ?? 0) !== 0,
  );

  if (completePeriods.length < 2) {
    return { geometry: null, periods, showsPayoutBand };
  }

  const dateKeys = completePeriods.map((period) => period.dateKey);
  const marketValues = completePeriods.map((period) => period.bands!.marketMinor);
  const netSavingsValues = completePeriods.map((period) => period.bands!.netSavingsMinor);

  const series = showsPayoutBand
    ? [
        { band: "market" as const, values: marketValues },
        {
          band: "payouts" as const,
          values: completePeriods.map((period) => period.bands!.payoutsMinor),
        },
        { band: "netSavings" as const, values: netSavingsValues },
      ]
    : [
        { band: "market" as const, values: marketValues },
        { band: "netSavings" as const, values: netSavingsValues },
      ];

  return {
    geometry: buildStackedChartGeometry(dateKeys, series),
    periods,
    showsPayoutBand,
  };
}
