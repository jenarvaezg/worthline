import type {
  DatedAmount,
  InvestmentOperation,
  NetWorthSnapshot,
  OwnershipShare,
  SnapshotHoldingRow,
  ValuationMethod,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  type BuildHeroBreakdownInput,
  buildHeroBreakdownData,
  formatHeroBreakdown,
} from "./hero-breakdown-data";

// ── seed helpers (mirroring delta-breakdown.test) ────────────────────────────

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

function snapshot(dateKey: string, totalMinor: number): NetWorthSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" as const });
  return {
    capturedAt: `${dateKey}T21:00:00.000Z`,
    dateKey,
    debts: money(0),
    grossAssets: money(totalMinor),
    housingEquity: money(0),
    id: `snap_${dateKey}`,
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

const scopeMemberIds = new Set(["member_a"]);
const ownership: ReadonlyMap<string, readonly OwnershipShare[]> = new Map([
  ["asset_fund", [{ memberId: "member_a", shareBps: 10_000 }]],
  ["asset_cash", [{ memberId: "member_a", shareBps: 10_000 }]],
  ["asset_rent", [{ memberId: "member_a", shareBps: 10_000 }]],
]);
const methods = new Map<string, ValuationMethod>([
  ["asset_fund", "derived"],
  ["asset_cash", "stored"],
  ["asset_rent", "appreciating"],
]);

function baseInput(
  overrides: Partial<BuildHeroBreakdownInput> & {
    snapshots: readonly NetWorthSnapshot[];
    holdingRowsBySnapshotId: ReadonlyMap<string, readonly SnapshotHoldingRow[]>;
  },
): BuildHeroBreakdownInput {
  return {
    operationsByHoldingId: new Map(),
    ownershipByHoldingId: ownership,
    payoutsByHolding: new Map(),
    scopeMemberIds,
    today: "2026-04-15",
    valuationMethodByHoldingId: methods,
    ...overrides,
  };
}

describe("buildHeroBreakdownData — monthly micro-band", () => {
  // Three confirmed closes (Jan/Feb/Mar, all before April): the latest computable
  // window is Feb→Mar.
  const snapshots = [
    snapshot("2026-01-31", 15_000_00),
    snapshot("2026-02-28", 16_500_00),
    snapshot("2026-03-31", 17_500_00),
  ];
  const holdingRowsBySnapshotId = new Map<string, readonly SnapshotHoldingRow[]>([
    ["snap_2026-01-31", [row("asset_fund", 10_000_00), row("asset_cash", 5_000_00)]],
    ["snap_2026-02-28", [row("asset_fund", 11_500_00), row("asset_cash", 5_000_00)]],
    ["snap_2026-03-31", [row("asset_fund", 12_000_00), row("asset_cash", 5_500_00)]],
  ]);

  test("picks the most recent close and splits it (market + savings)", () => {
    const { monthly } = buildHeroBreakdownData(
      baseInput({ holdingRowsBySnapshotId, snapshots }),
    );

    expect(monthly).not.toBeNull();
    expect(monthly!.monthKey).toBe("2026-03");
    expect(monthly!.aggregateDeltaMinor).toBe(1_000_00);
    expect(monthly!.showsPayouts).toBe(false);

    const byId = Object.fromEntries(monthly!.bands.map((b) => [b.id, b.amountMinor]));
    // Fund +500 pure market (no March ops), cash +500 savings.
    expect(byId.market).toBe(500_00);
    expect(byId.netSavings).toBe(500_00);
    expect(monthly!.bands.some((b) => b.id === "payouts")).toBe(false);
    // Magnitude weights sum to the full change.
    const weightSum = monthly!.bands.reduce((sum, b) => sum + b.weight, 0);
    expect(weightSum).toBeCloseTo(1, 5);
  });

  test("carves a payout band from the residual when payouts exist", () => {
    const payouts: DatedAmount[] = [{ amountMinor: 300_00, dateISO: "2026-03-10" }];
    const { monthly } = buildHeroBreakdownData(
      baseInput({
        holdingRowsBySnapshotId,
        payoutsByHolding: new Map([["asset_cash", payouts]]),
        snapshots,
      }),
    );

    expect(monthly!.showsPayouts).toBe(true);
    const byId = Object.fromEntries(monthly!.bands.map((b) => [b.id, b.amountMinor]));
    expect(byId.payouts).toBe(300_00);
    // Residual shrinks by the payout: netSavings 500 − 300 = 200.
    expect(byId.netSavings).toBe(200_00);
    expect(byId.market).toBe(500_00);
  });

  test("null when fewer than two confirmed closes", () => {
    const one = [snapshot("2026-03-31", 17_500_00)];
    const rows = new Map<string, readonly SnapshotHoldingRow[]>([
      ["snap_2026-03-31", [row("asset_fund", 12_000_00)]],
    ]);
    const { monthly } = buildHeroBreakdownData(
      baseInput({ holdingRowsBySnapshotId: rows, snapshots: one }),
    );
    expect(monthly).toBeNull();
  });
});

describe("buildHeroBreakdownData — weekly 'Esta semana'", () => {
  // Daily-ish snapshots spanning >7 days; base is the newest at least a week back.
  const snapshots = [
    snapshot("2026-04-01", 100_000_00),
    snapshot("2026-04-08", 100_500_00),
    snapshot("2026-04-15", 101_200_00),
  ];
  const holdingRowsBySnapshotId = new Map<string, readonly SnapshotHoldingRow[]>([
    ["snap_2026-04-01", [row("asset_fund", 60_000_00), row("asset_cash", 40_000_00)]],
    ["snap_2026-04-08", [row("asset_fund", 60_000_00), row("asset_cash", 40_500_00)]],
    ["snap_2026-04-15", [row("asset_fund", 60_400_00), row("asset_cash", 40_800_00)]],
  ]);

  test("splits the ~7-day window against the week-old base", () => {
    const { weekly } = buildHeroBreakdownData(
      baseInput({ holdingRowsBySnapshotId, snapshots }),
    );

    expect(weekly).not.toBeNull();
    expect(weekly!.windowStartDateKey).toBe("2026-04-08");
    expect(weekly!.windowEndDateKey).toBe("2026-04-15");
    expect(weekly!.aggregateDeltaMinor).toBe(700_00);

    const byId = Object.fromEntries(weekly!.bands.map((b) => [b.id, b.amountMinor]));
    // Fund +400 market (derived, no ops), cash +300 savings.
    expect(byId.market).toBe(400_00);
    expect(byId.netSavings).toBe(300_00);
  });

  test("derived market excludes in-window operations", () => {
    const { weekly } = buildHeroBreakdownData(
      baseInput({
        holdingRowsBySnapshotId,
        operationsByHoldingId: new Map([
          ["asset_fund", [buy("asset_fund", "2026-04-10", 400_00)]],
        ]),
        snapshots,
      }),
    );
    const byId = Object.fromEntries(weekly!.bands.map((b) => [b.id, b.amountMinor]));
    // The +400 fund move was a purchase, not market: market 0, savings +700.
    expect(byId.market).toBe(0);
    expect(byId.netSavings).toBe(700_00);
  });

  test("null when history is younger than a week", () => {
    const twoClose = [
      snapshot("2026-04-14", 100_000_00),
      snapshot("2026-04-15", 100_700_00),
    ];
    const rows = new Map<string, readonly SnapshotHoldingRow[]>([
      ["snap_2026-04-14", [row("asset_cash", 100_000_00)]],
      ["snap_2026-04-15", [row("asset_cash", 100_700_00)]],
    ]);
    const { weekly } = buildHeroBreakdownData(
      baseInput({ holdingRowsBySnapshotId: rows, snapshots: twoClose }),
    );
    expect(weekly).toBeNull();
  });
});

describe("formatHeroBreakdown", () => {
  const snapshots = [
    snapshot("2026-01-31", 15_000_00),
    snapshot("2026-02-28", 16_500_00),
    snapshot("2026-03-31", 17_500_00),
  ];
  const holdingRowsBySnapshotId = new Map<string, readonly SnapshotHoldingRow[]>([
    ["snap_2026-01-31", [row("asset_fund", 10_000_00), row("asset_cash", 5_000_00)]],
    ["snap_2026-02-28", [row("asset_fund", 11_500_00), row("asset_cash", 5_000_00)]],
    ["snap_2026-03-31", [row("asset_fund", 12_000_00), row("asset_cash", 5_500_00)]],
  ]);

  test("renders signed amounts, labels and whole-percent widths", () => {
    const data = buildHeroBreakdownData(
      baseInput({ holdingRowsBySnapshotId, snapshots }),
    );
    const formatted = formatHeroBreakdown(data, "EUR", false);

    expect(formatted.monthly).not.toBeNull();
    expect(formatted.monthly!.monthLabel).toMatch(/marzo/i);
    expect(formatted.monthly!.aggregateFmt.startsWith("+")).toBe(true);
    const market = formatted.monthly!.bands.find((b) => b.id === "market")!;
    expect(market.label).toBe("Mercado");
    expect(market.amountFmt.startsWith("+")).toBe(true);
    expect(market.sign).toBe("pos");
    const widthSum = formatted.monthly!.bands.reduce((sum, b) => sum + b.weightPct, 0);
    expect(widthSum).toBeGreaterThanOrEqual(99);
    expect(widthSum).toBeLessThanOrEqual(101);
  });

  test("privacy mode masks the figures", () => {
    const data = buildHeroBreakdownData(
      baseInput({ holdingRowsBySnapshotId, snapshots }),
    );
    const formatted = formatHeroBreakdown(data, "EUR", true);
    expect(formatted.monthly!.aggregateFmt).not.toMatch(/\d/);
  });
});
