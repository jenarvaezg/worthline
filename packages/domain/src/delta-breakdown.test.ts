import { describe, expect, test } from "vitest";
import {
  buildMonthlyCloseBreakdownSeries,
  computeDeltaBreakdownWindow,
  periodShowsPayoutBand,
} from "./delta-breakdown";
import type { ValuationMethod } from "./holding-valuation";
import type { InvestmentOperation } from "./investment-types";
import type { DatedAmount } from "./payouts";
import type { SnapshotHoldingRow } from "./snapshot-holdings";
import type { NetWorthSnapshot } from "./snapshot-types";

function row(
  holdingId: string,
  valueMinor: number,
  kind: SnapshotHoldingRow["kind"] = "asset",
): SnapshotHoldingRow {
  return {
    countsAsHousing: false,
    holdingId,
    kind,
    label: holdingId,
    liquidityTier: "market",
    securesHousing: false,
    valueMinor,
  };
}

function snapshot(dateKey: string, totalMinor: number, id?: string): NetWorthSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" as const });
  return {
    capturedAt: `${dateKey}T10:00:00.000Z`,
    dateKey,
    debts: money(0),
    grossAssets: money(totalMinor),
    housingEquity: money(0),
    id: id ?? `snap_${dateKey}`,
    isMonthlyClose: false,
    liquidNetWorth: money(totalMinor),
    monthKey: dateKey.slice(0, 7),
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: money(totalMinor),
    warnings: [],
  };
}

function buy(
  assetId: string,
  executedAt: string,
  amountMinor: number,
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt: `${executedAt}T12:00:00.000Z`,
    feesMinor: 0,
    id: `op_${executedAt}_${assetId}`,
    kind: "buy",
    pricePerUnit: String(amountMinor / 100),
    units: "1",
  };
}

const householdScope = new Set(["member_a"]);
const fullOwnership = new Map([
  ["asset_fund", [{ memberId: "member_a", shareBps: 10_000 }]],
  ["asset_cash", [{ memberId: "member_a", shareBps: 10_000 }]],
  ["asset_rent", [{ memberId: "member_a", shareBps: 10_000 }]],
]);

const methods = new Map<string, ValuationMethod>([
  ["asset_fund", "derived"],
  ["asset_cash", "stored"],
  ["asset_rent", "appreciating"],
]);

describe("computeDeltaBreakdownWindow", () => {
  test("derived holding: market is value change minus net operations", () => {
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: 1_500_00,
      currentRows: [row("asset_fund", 11_500_00)],
      operationsByHoldingId: new Map([
        ["asset_fund", [buy("asset_fund", "2026-02-15", 1_000_00)]],
      ]),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map(),
      previousRows: [row("asset_fund", 10_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.marketMinor).toBe(500_00);
    expect(bands.payoutsMinor).toBe(0);
    expect(bands.netSavingsMinor).toBe(1_000_00);
    expect(bands.marketMinor + bands.payoutsMinor + bands.netSavingsMinor).toBe(1_500_00);
  });

  test("payout series carves from residual exactly", () => {
    const payouts: DatedAmount[] = [{ amountMinor: 800_00, dateISO: "2026-02-10" }];
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: 800_00,
      currentRows: [row("asset_cash", 5_800_00), row("asset_rent", 200_000_00)],
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map([["asset_rent", payouts]]),
      previousRows: [row("asset_cash", 5_000_00), row("asset_rent", 200_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.marketMinor).toBe(0);
    expect(bands.payoutsMinor).toBe(800_00);
    expect(bands.netSavingsMinor).toBe(0);
    expect(bands.marketMinor + bands.payoutsMinor + bands.netSavingsMinor).toBe(800_00);
  });

  test("modeled holding attributes full value change to market", () => {
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: 300_00,
      currentRows: [row("asset_rent", 200_300_00)],
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map(),
      previousRows: [row("asset_rent", 200_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.marketMinor).toBe(300_00);
    expect(bands.netSavingsMinor).toBe(0);
  });

  test("stored holding value change stays in net savings", () => {
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: 2_000_00,
      currentRows: [row("asset_cash", 7_000_00)],
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map(),
      previousRows: [row("asset_cash", 5_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.marketMinor).toBe(0);
    expect(bands.netSavingsMinor).toBe(2_000_00);
  });

  test("residual may be negative on heavy spending", () => {
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: -4_000_00,
      currentRows: [row("asset_cash", 1_000_00)],
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map(),
      previousRows: [row("asset_cash", 5_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.netSavingsMinor).toBe(-4_000_00);
  });

  test("scope weighting halves a co-owned payout", () => {
    const payouts: DatedAmount[] = [{ amountMinor: 1_000_00, dateISO: "2026-02-10" }];
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: 500_00,
      currentRows: [row("asset_cash", 5_500_00)],
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: new Map([
        ["asset_cash", [{ memberId: "member_a", shareBps: 5_000 }]],
        ["asset_rent", [{ memberId: "member_a", shareBps: 5_000 }]],
      ]),
      payoutsByHolding: new Map([["asset_rent", payouts]]),
      previousRows: [row("asset_cash", 5_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.payoutsMinor).toBe(500_00);
    expect(bands.netSavingsMinor).toBe(0);
  });

  test("window edges exclude the start date and include the end date", () => {
    const payouts: DatedAmount[] = [
      { amountMinor: 100_00, dateISO: "2026-01-31" },
      { amountMinor: 200_00, dateISO: "2026-02-01" },
      { amountMinor: 300_00, dateISO: "2026-02-28" },
      { amountMinor: 400_00, dateISO: "2026-03-01" },
    ];
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: 500_00,
      currentRows: [row("asset_cash", 5_500_00)],
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map([["asset_rent", payouts]]),
      previousRows: [row("asset_cash", 5_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.payoutsMinor).toBe(500_00);
  });

  test("empty payout series is a no-op", () => {
    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor: 1_000_00,
      currentRows: [row("asset_cash", 6_000_00)],
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map([["asset_rent", []]]),
      previousRows: [row("asset_cash", 5_000_00)],
      scopeMemberIds: householdScope,
      valuationMethodByHoldingId: methods,
      windowEndInclusive: "2026-02-28",
      windowStartExclusive: "2026-01-31",
    });

    expect(bands.payoutsMinor).toBe(0);
    expect(bands.netSavingsMinor).toBe(1_000_00);
  });
});

describe("buildMonthlyCloseBreakdownSeries", () => {
  test("returns gaps when frozen rows are missing for a close", () => {
    const jan = snapshot("2026-01-31", 100_000_00);
    const feb = snapshot("2026-02-28", 101_000_00);
    const series = buildMonthlyCloseBreakdownSeries({
      holdingRowsBySnapshotId: new Map([[jan.id, [row("asset_cash", 100_000_00)]]]),
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: new Map(),
      scopeMemberIds: householdScope,
      snapshots: [jan, feb],
      today: "2026-03-10",
      valuationMethodByHoldingId: methods,
    });

    expect(series).toHaveLength(1);
    expect(series[0]?.bands).toBeNull();
  });

  test("builds one period per confirmed monthly close pair", () => {
    const jan = snapshot("2026-01-31", 100_000_00);
    const feb = snapshot("2026-02-28", 101_500_00);
    const mar = snapshot("2026-03-31", 101_000_00);

    const payouts = new Map<string, DatedAmount[]>([
      ["asset_rent", [{ amountMinor: 500_00, dateISO: "2026-02-15" }]],
    ]);

    const series = buildMonthlyCloseBreakdownSeries({
      holdingRowsBySnapshotId: new Map([
        [jan.id, [row("asset_cash", 100_000_00)]],
        [feb.id, [row("asset_cash", 101_500_00)]],
        [mar.id, [row("asset_cash", 101_000_00)]],
      ]),
      operationsByHoldingId: new Map(),
      ownershipByHoldingId: fullOwnership,
      payoutsByHolding: payouts,
      scopeMemberIds: householdScope,
      snapshots: [jan, feb, mar],
      today: "2026-04-10",
      valuationMethodByHoldingId: methods,
    });

    expect(series).toHaveLength(2);
    expect(series[0]?.bands?.payoutsMinor).toBe(500_00);
    expect(series[1]?.bands?.payoutsMinor).toBe(0);
    expect(periodShowsPayoutBand(series[0]!)).toBe(true);
    expect(periodShowsPayoutBand(series[1]!)).toBe(false);
  });
});

describe("periodShowsPayoutBand", () => {
  test("false for gaps and zero-payout months", () => {
    expect(
      periodShowsPayoutBand({
        aggregateDeltaMinor: 0,
        bands: null,
        dateKey: "2026-02-28",
        monthKey: "2026-02",
      }),
    ).toBe(false);
    expect(
      periodShowsPayoutBand({
        aggregateDeltaMinor: 100,
        bands: { marketMinor: 100, netSavingsMinor: 0, payoutsMinor: 0 },
        dateKey: "2026-02-28",
        monthKey: "2026-02",
      }),
    ).toBe(false);
  });
});
