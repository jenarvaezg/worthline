import type { NetWorthSnapshot } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  buildMoversData,
  buildMoversDataByPeriod,
  type MoversHoldingRow,
  moversBaseSnapshot,
  parseMoversPeriod,
} from "./movers-data";

function snap(monthKey: string, dateKey: string): NetWorthSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: "EUR" as const });
  return {
    capturedAt: `${dateKey}T10:00:00.000Z`,
    dateKey,
    debts: money(0),
    grossAssets: money(0),
    housingEquity: money(0),
    id: `snap_${dateKey}`,
    isMonthlyClose: true,
    liquidNetWorth: money(0),
    monthKey,
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: money(0),
    warnings: [],
  };
}

function row(
  over: Partial<MoversHoldingRow> &
    Pick<MoversHoldingRow, "holdingId" | "dateKey" | "valueMinor">,
): MoversHoldingRow {
  return {
    kind: "asset",
    label: over.holdingId,
    liquidityTier: "market",
    securesHousing: false,
    ...over,
  };
}

describe("parseMoversPeriod", () => {
  test("defaults to month", () => {
    expect(parseMoversPeriod(undefined)).toBe("month");
    expect(parseMoversPeriod("bogus")).toBe("month");
  });

  test("reads year from search params", () => {
    expect(parseMoversPeriod("year")).toBe("year");
    expect(parseMoversPeriod(["year"])).toBe("year");
  });
});

describe("moversBaseSnapshot", () => {
  const snapshots = [
    snap("2024-11", "2024-11-30"),
    snap("2024-12", "2024-12-31"),
    snap("2025-01", "2025-01-31"),
  ];

  test("month period picks the prior monthly close", () => {
    expect(moversBaseSnapshot(snapshots, "month")?.monthKey).toBe("2024-12");
  });

  test("year period picks the YoY base month", () => {
    const withYearBase = [snap("2024-01", "2024-01-31"), ...snapshots];
    expect(moversBaseSnapshot(withYearBase, "year")?.monthKey).toBe("2024-01");
  });
});

describe("buildMoversData", () => {
  const snapshots = [snap("2024-12", "2024-12-31"), snap("2025-01", "2025-01-31")];
  const holdingRows: MoversHoldingRow[] = [
    row({ holdingId: "cash", dateKey: "2024-12-31", valueMinor: 1_000_00 }),
    row({ holdingId: "cash", dateKey: "2025-01-31", valueMinor: 1_500_00 }),
  ];

  test("ranks gainers and losers by € impact", () => {
    const data = buildMoversData({
      snapshots,
      selectedView: "total",
      period: "month",
      holdingRows,
      currency: "EUR",
      privacyMode: false,
    });
    expect(data?.hasBase).toBe(true);
    expect(data?.up).toHaveLength(1);
    expect(data?.up[0]?.label).toBe("cash");
    expect(data?.down).toHaveLength(0);
  });
});

describe("buildMoversDataByPeriod", () => {
  test("precomputes both month and year slices", () => {
    const snapshots = [snap("2024-12", "2024-12-31"), snap("2025-01", "2025-01-31")];
    const holdingRows: MoversHoldingRow[] = [
      row({ holdingId: "cash", dateKey: "2024-12-31", valueMinor: 1_000_00 }),
      row({ holdingId: "cash", dateKey: "2025-01-31", valueMinor: 1_200_00 }),
    ];
    const byPeriod = buildMoversDataByPeriod({
      snapshots,
      selectedView: "total",
      holdingRows,
      currency: "EUR",
      privacyMode: false,
    });
    expect(byPeriod?.month.hasBase).toBe(true);
    expect(byPeriod?.year.hasBase).toBe(false);
  });
});
