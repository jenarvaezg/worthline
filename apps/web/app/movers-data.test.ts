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

function build(params: {
  snapshots?: NetWorthSnapshot[];
  selectedView?: "total" | "liquid";
  period?: "month" | "year";
  holdingRows: MoversHoldingRow[];
}) {
  const snapshots = params.snapshots ?? [
    snap("2024-12", "2024-12-31"),
    snap("2025-01", "2025-01-31"),
  ];
  return buildMoversData({
    snapshots,
    selectedView: params.selectedView ?? "total",
    period: params.period ?? "month",
    holdingRows: params.holdingRows,
    currency: "EUR",
    privacyMode: false,
  });
}

describe("buildMoversData", () => {
  test("ranks gainers and losers by € impact", () => {
    const data = build({
      holdingRows: [
        row({ holdingId: "cash", dateKey: "2024-12-31", valueMinor: 1_000_00 }),
        row({ holdingId: "cash", dateKey: "2025-01-31", valueMinor: 1_500_00 }),
      ],
    });
    expect(data?.hasBase).toBe(true);
    expect(data?.up).toHaveLength(1);
    expect(data?.up[0]?.label).toBe("cash");
    expect(data?.down).toHaveLength(0);
  });

  test("treats debt paydown as a positive mover", () => {
    const data = build({
      holdingRows: [
        row({
          kind: "liability",
          holdingId: "loan",
          label: "Préstamo",
          dateKey: "2024-12-31",
          valueMinor: 5_000_00,
        }),
        row({
          kind: "liability",
          holdingId: "loan",
          label: "Préstamo",
          dateKey: "2025-01-31",
          valueMinor: 4_000_00,
        }),
      ],
    });
    expect(data?.up).toHaveLength(1);
    expect(data?.up[0]?.label).toBe("Préstamo");
    expect(data?.up[0]?.sign).toBe("pos");
    expect(data?.up[0]?.changeFmt.startsWith("+")).toBe(true);
  });

  test("treats increased debt as a negative mover", () => {
    const data = build({
      holdingRows: [
        row({
          kind: "liability",
          holdingId: "loan",
          label: "Préstamo",
          dateKey: "2024-12-31",
          valueMinor: 4_000_00,
        }),
        row({
          kind: "liability",
          holdingId: "loan",
          label: "Préstamo",
          dateKey: "2025-01-31",
          valueMinor: 5_000_00,
        }),
      ],
    });
    expect(data?.down).toHaveLength(1);
    expect(data?.down[0]?.label).toBe("Préstamo");
    expect(data?.down[0]?.sign).toBe("neg");
    expect(
      data?.down[0]?.changeFmt.startsWith("-") ||
        data?.down[0]?.changeFmt.startsWith("−"),
    ).toBe(true);
  });

  test("filters non-liquid holdings in the liquid framing", () => {
    const data = build({
      selectedView: "liquid",
      holdingRows: [
        row({
          holdingId: "cash",
          liquidityTier: "cash",
          dateKey: "2024-12-31",
          valueMinor: 1_000_00,
        }),
        row({
          holdingId: "cash",
          liquidityTier: "cash",
          dateKey: "2025-01-31",
          valueMinor: 1_200_00,
        }),
        row({
          holdingId: "house",
          label: "Vivienda",
          liquidityTier: "housing",
          dateKey: "2024-12-31",
          valueMinor: 200_000_00,
        }),
        row({
          holdingId: "house",
          label: "Vivienda",
          liquidityTier: "housing",
          dateKey: "2025-01-31",
          valueMinor: 210_000_00,
        }),
      ],
    });
    expect(data?.up.map((m) => m.label)).toEqual(["cash"]);
    expect(data?.down).toHaveLength(0);
  });

  test("excludes housing-secured liabilities from the liquid framing", () => {
    const data = build({
      selectedView: "liquid",
      holdingRows: [
        row({
          kind: "liability",
          holdingId: "mortgage",
          label: "Hipoteca",
          liquidityTier: "housing",
          securesHousing: true,
          dateKey: "2024-12-31",
          valueMinor: 100_000_00,
        }),
        row({
          kind: "liability",
          holdingId: "mortgage",
          label: "Hipoteca",
          liquidityTier: "housing",
          securesHousing: true,
          dateKey: "2025-01-31",
          valueMinor: 90_000_00,
        }),
      ],
    });
    expect(data?.up).toHaveLength(0);
    expect(data?.down).toHaveLength(0);
  });

  test("tags brand-new holdings as nuevo", () => {
    const data = build({
      holdingRows: [
        row({
          holdingId: "etf",
          label: "ETF",
          dateKey: "2025-01-31",
          valueMinor: 5_000_00,
        }),
      ],
    });
    expect(data?.up).toHaveLength(1);
    expect(data?.up[0]?.tag).toBe("nuevo");
    expect(data?.up[0]?.pctFmt).toBeNull();
  });

  test("tags fully sold holdings as vendido", () => {
    const data = build({
      holdingRows: [
        row({
          holdingId: "etf",
          label: "ETF",
          dateKey: "2024-12-31",
          valueMinor: 5_000_00,
        }),
      ],
    });
    expect(data?.down).toHaveLength(1);
    expect(data?.down[0]?.tag).toBe("vendido");
  });

  test("keeps only the top four gainers and losers by € impact", () => {
    const gainers = Array.from({ length: 6 }, (_, index) => {
      const amount = (index + 1) * 100_00;
      return [
        row({
          holdingId: `g${index}`,
          label: `G${index}`,
          dateKey: "2024-12-31",
          valueMinor: 0,
        }),
        row({
          holdingId: `g${index}`,
          label: `G${index}`,
          dateKey: "2025-01-31",
          valueMinor: amount,
        }),
      ];
    }).flat();
    const losers = Array.from({ length: 6 }, (_, index) => {
      const amount = (index + 1) * 100_00;
      return [
        row({
          holdingId: `l${index}`,
          label: `L${index}`,
          dateKey: "2024-12-31",
          valueMinor: amount,
        }),
        row({
          holdingId: `l${index}`,
          label: `L${index}`,
          dateKey: "2025-01-31",
          valueMinor: 0,
        }),
      ];
    }).flat();

    const data = build({ holdingRows: [...gainers, ...losers] });
    expect(data?.up).toHaveLength(4);
    expect(data?.down).toHaveLength(4);
    expect(data?.up.map((m) => m.label)).toEqual(["G5", "G4", "G3", "G2"]);
    expect(data?.down.map((m) => m.label)).toEqual(["L5", "L4", "L3", "L2"]);
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
