/**
 * Net-worth composition chart (#142, ADR 0009).
 *
 * The dashboard's single historical chart: gross asset components stack above
 * zero in five bands (the four liquidity-ladder rungs plus a Vivienda band
 * sourced from the `property` instrument by holding id — the ADR 0013 bridge,
 * identical carve to the drilldown), one aggregated debt stack below zero, and
 * a net-worth line. Pure presentation math — numbers and strings only.
 */
import { describe, expect, test } from "vitest";

import type { DatedSnapshotHoldingRow } from "./drilldown";
import {
  availableCompositionRanges,
  buildCompositionChartGeometry,
  buildCompositionSeries,
  COMPOSITION_CHART_HEIGHT,
  deriveCompositionBands,
  granularityForSpanMonths,
  rangeStartMonthKey,
  selectMonthlySeries,
  selectPeriodicSeries,
} from "./composition-chart";
import type { CompositionSeriesPoint } from "./composition-chart";
import type { LiquidityTier } from "./classification";
import type { SnapshotHoldingKind } from "./snapshot-holdings";

function row(input: {
  holdingId: string;
  tier: LiquidityTier | null;
  valueMinor: number;
  kind?: SnapshotHoldingKind;
  dateKey?: string;
}): DatedSnapshotHoldingRow {
  return {
    countsAsHousing: false,
    dateKey: input.dateKey ?? "2026-06-30",
    holdingId: input.holdingId,
    kind: input.kind ?? "asset",
    label: input.holdingId,
    liquidityTier: input.tier,
    securesHousing: false,
    valueMinor: input.valueMinor,
  };
}

function parseCoords(points: string): Array<{ x: number; y: number }> {
  return points
    .trim()
    .split(" ")
    .map((pair) => {
      const [x, y] = pair.split(",");
      return { x: Number(x), y: Number(y) };
    });
}

/** Maps a minor-unit value through the geometry's own y domain. */
function yFor(value: number, yMin: number, yMax: number): number {
  return (
    COMPOSITION_CHART_HEIGHT - ((value - yMin) / (yMax - yMin)) * COMPOSITION_CHART_HEIGHT
  );
}

function seriesPoint(
  dateKey: string,
  bands: Partial<
    Omit<CompositionSeriesPoint, "dateKey" | "isOpenPeriod" | "netWorthMinor">
  >,
  isOpenPeriod = false,
): CompositionSeriesPoint {
  const cashMinor = bands.cashMinor ?? 0;
  const marketMinor = bands.marketMinor ?? 0;
  const termLockedMinor = bands.termLockedMinor ?? 0;
  const illiquidMinor = bands.illiquidMinor ?? 0;
  const housingMinor = bands.housingMinor ?? 0;
  const debtsMinor = bands.debtsMinor ?? 0;
  return {
    cashMinor,
    dateKey,
    debtsMinor,
    housingMinor,
    illiquidMinor,
    isOpenPeriod,
    marketMinor,
    netWorthMinor:
      cashMinor +
      marketMinor +
      termLockedMinor +
      illiquidMinor +
      housingMinor -
      debtsMinor,
    termLockedMinor,
  };
}

describe("deriveCompositionBands", () => {
  test("sums asset rows into their rung band and liabilities into debts; net worth is assets − debts", () => {
    const bands = deriveCompositionBands(
      [
        row({ holdingId: "a_cash", tier: "cash", valueMinor: 100_00 }),
        row({ holdingId: "l_card", tier: null, valueMinor: 30_00, kind: "liability" }),
      ],
      [],
    );

    expect(bands).toEqual({
      cashMinor: 100_00,
      debtsMinor: 30_00,
      housingMinor: 0,
      illiquidMinor: 0,
      marketMinor: 0,
      netWorthMinor: 70_00,
      termLockedMinor: 0,
    });
  });

  test("carves housing out of the illiquid rung by holding id, never double-counting", () => {
    const bands = deriveCompositionBands(
      [
        row({ holdingId: "a_house", tier: "illiquid", valueMinor: 300_000_00 }),
        row({ holdingId: "a_art", tier: "illiquid", valueMinor: 20_000_00 }),
      ],
      ["a_house"],
    );

    expect(bands.housingMinor).toBe(300_000_00);
    expect(bands.illiquidMinor).toBe(20_000_00);
  });

  test("five asset bands partition gross assets; net worth = gross − debts", () => {
    const rows = [
      row({ holdingId: "a_cash", tier: "cash", valueMinor: 10_000_00 }),
      row({ holdingId: "a_fund", tier: "market", valueMinor: 50_000_00 }),
      row({ holdingId: "a_pension", tier: "term-locked", valueMinor: 30_000_00 }),
      row({ holdingId: "a_art", tier: "illiquid", valueMinor: 5_000_00 }),
      row({ holdingId: "a_house", tier: "illiquid", valueMinor: 250_000_00 }),
      row({
        holdingId: "l_mortgage",
        tier: "illiquid",
        valueMinor: 120_000_00,
        kind: "liability",
      }),
    ];

    const bands = deriveCompositionBands(rows, ["a_house"]);
    const grossMinor =
      bands.cashMinor +
      bands.marketMinor +
      bands.termLockedMinor +
      bands.illiquidMinor +
      bands.housingMinor;

    expect(grossMinor).toBe(345_000_00);
    expect(bands.debtsMinor).toBe(120_000_00);
    expect(bands.netWorthMinor).toBe(345_000_00 - 120_000_00);
  });
});

describe("selectMonthlySeries", () => {
  test("keeps the last snapshot of each month; flags the current month as the open period", () => {
    const snapshots = [
      { dateKey: "2026-04-10", monthKey: "2026-04" },
      { dateKey: "2026-04-28", monthKey: "2026-04" },
      { dateKey: "2026-05-31", monthKey: "2026-05" },
      { dateKey: "2026-06-05", monthKey: "2026-06" },
      { dateKey: "2026-06-13", monthKey: "2026-06" },
    ];

    const series = selectMonthlySeries(snapshots, "2026-06-13");

    expect(series).toEqual([
      { dateKey: "2026-04-28", isOpenPeriod: false },
      { dateKey: "2026-05-31", isOpenPeriod: false },
      { dateKey: "2026-06-13", isOpenPeriod: true },
    ]);
  });

  test("no current-month snapshot → every entry is a finalized close", () => {
    const series = selectMonthlySeries(
      [
        { dateKey: "2026-04-28", monthKey: "2026-04" },
        { dateKey: "2026-05-31", monthKey: "2026-05" },
      ],
      "2026-06-13",
    );

    expect(series.map((entry) => entry.dateKey)).toEqual(["2026-04-28", "2026-05-31"]);
    expect(series.every((entry) => !entry.isOpenPeriod)).toBe(true);
  });
});

describe("buildCompositionSeries", () => {
  test("assembles one banded point per monthly base point from that date's rows", () => {
    const rows = [
      row({
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100_00,
        dateKey: "2026-05-31",
      }),
      row({
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 150_00,
        dateKey: "2026-06-13",
      }),
      row({
        holdingId: "l_card",
        tier: null,
        valueMinor: 40_00,
        kind: "liability",
        dateKey: "2026-06-13",
      }),
    ];
    const snapshots = [
      { dateKey: "2026-05-31", monthKey: "2026-05" },
      { dateKey: "2026-06-13", monthKey: "2026-06" },
    ];

    const series = buildCompositionSeries({
      housingHoldingIds: [],
      rows,
      snapshots,
      today: "2026-06-13",
    });

    expect(
      series.map((point) => ({
        cash: point.cashMinor,
        dateKey: point.dateKey,
        debts: point.debtsMinor,
        isOpenPeriod: point.isOpenPeriod,
        net: point.netWorthMinor,
      })),
    ).toEqual([
      { cash: 100_00, dateKey: "2026-05-31", debts: 0, isOpenPeriod: false, net: 100_00 },
      {
        cash: 150_00,
        dateKey: "2026-06-13",
        debts: 40_00,
        isOpenPeriod: true,
        net: 110_00,
      },
    ]);
  });

  test("omits monthly points whose snapshot has no frozen rows (legacy pre-ADR-0008 captures)", () => {
    // A legacy snapshot carries no holding rows; plotting it would draw a false
    // zero. Only row-backed snapshots — whose bands reconcile to the headline —
    // belong on the chart.
    const rows = [
      row({
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100_00,
        dateKey: "2026-06-30",
      }),
    ];
    const snapshots = [
      { dateKey: "2026-05-31", monthKey: "2026-05" },
      { dateKey: "2026-06-30", monthKey: "2026-06" },
    ];

    const series = buildCompositionSeries({
      housingHoldingIds: [],
      rows,
      snapshots,
      today: "2026-06-30",
    });

    expect(series.map((point) => point.dateKey)).toEqual(["2026-06-30"]);
  });
});

describe("buildCompositionChartGeometry", () => {
  test("returns null below the two-point placeholder threshold", () => {
    expect(
      buildCompositionChartGeometry([seriesPoint("2026-06-30", { cashMinor: 100_00 })]),
    ).toBeNull();
  });

  test("returns null for a degenerate zero-length time span", () => {
    expect(
      buildCompositionChartGeometry([
        seriesPoint("2026-06-30", { cashMinor: 100_00 }),
        seriesPoint("2026-06-30", { cashMinor: 200_00 }),
      ]),
    ).toBeNull();
  });

  test("stacks five asset bands above zero, debt below, and a net-worth line over the total", () => {
    const points = [
      seriesPoint("2026-05-31", {
        cashMinor: 100_00,
        housingMinor: 200_000_00,
        debtsMinor: 50_000_00,
      }),
      seriesPoint(
        "2026-06-30",
        { cashMinor: 120_00, housingMinor: 200_000_00, debtsMinor: 40_000_00 },
        true,
      ),
    ];

    const geometry = buildCompositionChartGeometry(points)!;

    expect(geometry.assetBands.map((band) => band.band)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
    // Debt present anywhere → one aggregated negative stack.
    expect(geometry.debtArea).not.toBeNull();
    // Zero baseline sits between the asset stack (above) and the debt stack (below).
    expect(geometry.baselineY).toBeCloseTo(yFor(0, geometry.yMin, geometry.yMax), 2);
    // The net-worth line maps each period's net worth.
    const lineCoords = parseCoords(geometry.netWorthLine);
    expect(lineCoords[0]!.y).toBeCloseTo(
      yFor(points[0]!.netWorthMinor, geometry.yMin, geometry.yMax),
      2,
    );
    // Every period is exposed for hover, with its open/closed flag.
    expect(geometry.periods.map((p) => p.dateKey)).toEqual(["2026-05-31", "2026-06-30"]);
    expect(geometry.periods.map((p) => p.isOpenPeriod)).toEqual([false, true]);
  });

  test("excluding a band drops it from the stack/anchors and rescales to the rest", () => {
    const points = [
      seriesPoint("2026-05-31", { cashMinor: 10_000_00, housingMinor: 500_000_00 }),
      seriesPoint("2026-06-30", { cashMinor: 12_000_00, housingMinor: 500_000_00 }),
    ];

    const full = buildCompositionChartGeometry(points)!;
    const exHousing = buildCompositionChartGeometry(points, {
      excludedBands: ["housing"],
    })!;

    // Housing is gone from the rendered bands and the per-period hover anchors.
    expect(exHousing.assetBands.map((band) => band.band)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
    ]);
    expect(exHousing.periods[0]!.assetBands.some((a) => a.band === "housing")).toBe(
      false,
    );
    // The y domain no longer spans the 500k housing → it rescales much smaller.
    expect(exHousing.yMax).toBeLessThan(full.yMax / 10);
    // The net-worth line now excludes housing: net = cash − debts (no debt here).
    expect(exHousing.periods[0]!.netWorth.valueMinor).toBe(10_000_00);
  });

  test("no debt in any period → no debt stack and no debt hover anchor", () => {
    const geometry = buildCompositionChartGeometry([
      seriesPoint("2026-05-31", { cashMinor: 100_00 }),
      seriesPoint("2026-06-30", { cashMinor: 120_00 }),
    ])!;

    expect(geometry.debtArea).toBeNull();
    expect(geometry.periods.every((p) => p.debt === null)).toBe(true);
  });

  test("each period exposes per-band, debt and net-worth hover anchors with values", () => {
    const points = [
      seriesPoint("2026-05-31", {
        cashMinor: 10_000_00,
        housingMinor: 200_000_00,
        debtsMinor: 120_000_00,
      }),
      seriesPoint("2026-06-30", { cashMinor: 12_000_00, housingMinor: 200_000_00 }),
    ];

    const geometry = buildCompositionChartGeometry(points)!;
    const may = geometry.periods[0]!;

    // Five asset-band anchors in stacking order, each carrying that band's value.
    expect(may.assetBands.map((b) => b.band)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
    expect(may.assetBands.find((b) => b.band === "cash")!.valueMinor).toBe(10_000_00);
    expect(may.assetBands.find((b) => b.band === "housing")!.valueMinor).toBe(200_000_00);
    // Debt anchor present (this period has debt) with the aggregated balance.
    expect(may.debt!.valueMinor).toBe(120_000_00);
    // Net-worth anchor sits on the line.
    expect(may.netWorth.valueMinor).toBe(points[0]!.netWorthMinor);
    expect(may.netWorth.y).toBeCloseTo(
      yFor(points[0]!.netWorthMinor, geometry.yMin, geometry.yMax),
      2,
    );
    // All anchors of a period share its x.
    const xs = new Set([...may.assetBands.map((b) => b.x), may.debt!.x, may.netWorth.x]);
    expect(xs.size).toBe(1);
    // The period that carries no debt exposes a null debt anchor.
    expect(geometry.periods[1]!.debt).toBeNull();
  });
});

// ── #144: temporal range + adaptive density ──────────────────────────────────

describe("rangeStartMonthKey", () => {
  test("bounded ranges count back inclusive of the current month", () => {
    expect(rangeStartMonthKey("2026-06-13", "1y")).toBe("2025-07");
    expect(rangeStartMonthKey("2026-06-13", "3y")).toBe("2023-07");
    expect(rangeStartMonthKey("2026-06-13", "5y")).toBe("2021-07");
  });

  test("crossing the year boundary borrows correctly", () => {
    expect(rangeStartMonthKey("2026-02-01", "1y")).toBe("2025-03");
    expect(rangeStartMonthKey("2026-01-15", "1y")).toBe("2025-02");
  });

  test("'all' is unbounded — no cutoff", () => {
    expect(rangeStartMonthKey("2026-06-13", "all")).toBeNull();
  });
});

describe("granularityForSpanMonths", () => {
  test("monthly up to 3 years, quarterly up to 7, annual beyond", () => {
    expect(granularityForSpanMonths(0)).toBe("month");
    expect(granularityForSpanMonths(36)).toBe("month");
    expect(granularityForSpanMonths(37)).toBe("quarter");
    expect(granularityForSpanMonths(84)).toBe("quarter");
    expect(granularityForSpanMonths(85)).toBe("year");
  });
});

describe("availableCompositionRanges", () => {
  test("offers only bounded ranges the history exceeds, plus 'all'", () => {
    // ~2 years of data → only 1A is meaningful besides Todo (the worked example).
    expect(availableCompositionRanges(24)).toEqual(["1y", "all"]);
    // Under a year → only Todo (the control should hide itself).
    expect(availableCompositionRanges(6)).toEqual(["all"]);
    // Exactly a year of data → 1A would equal Todo, so only Todo.
    expect(availableCompositionRanges(12)).toEqual(["all"]);
    // Long history → every range.
    expect(availableCompositionRanges(120)).toEqual(["1y", "3y", "5y", "all"]);
  });
});

describe("selectPeriodicSeries", () => {
  const snaps = [
    { dateKey: "2024-02-15" },
    { dateKey: "2024-03-31" },
    { dateKey: "2024-06-30" },
    { dateKey: "2025-01-10" },
    { dateKey: "2026-05-31" },
    { dateKey: "2026-06-13" },
  ];

  test("monthly keeps the last snapshot of each month", () => {
    expect(
      selectPeriodicSeries(snaps, "2026-06-13", "month").map((e) => e.dateKey),
    ).toEqual([
      "2024-02-15",
      "2024-03-31",
      "2024-06-30",
      "2025-01-10",
      "2026-05-31",
      "2026-06-13",
    ]);
  });

  test("quarterly keeps the last snapshot of each calendar quarter", () => {
    expect(
      selectPeriodicSeries(snaps, "2026-06-13", "quarter").map((e) => e.dateKey),
    ).toEqual([
      "2024-03-31", // Q1 2024 (feb + mar → mar wins)
      "2024-06-30", // Q2 2024
      "2025-01-10", // Q1 2025
      "2026-06-13", // Q2 2026 (may + jun → jun wins)
    ]);
  });

  test("annual keeps the last snapshot of each year", () => {
    expect(
      selectPeriodicSeries(snaps, "2026-06-13", "year").map((e) => e.dateKey),
    ).toEqual(["2024-06-30", "2025-01-10", "2026-06-13"]);
  });

  test("flags the period that contains today as the open one, at any granularity", () => {
    const q = selectPeriodicSeries(snaps, "2026-06-13", "quarter");
    expect(q.at(-1)).toEqual({ dateKey: "2026-06-13", isOpenPeriod: true });
    expect(q.slice(0, -1).every((e) => !e.isOpenPeriod)).toBe(true);

    const y = selectPeriodicSeries(snaps, "2026-06-13", "year");
    expect(y.at(-1)!.isOpenPeriod).toBe(true);
    expect(y.find((e) => e.dateKey === "2025-01-10")!.isOpenPeriod).toBe(false);
  });
});

describe("buildCompositionSeries — range window and adaptive density", () => {
  /** N consecutive monthly closes (day 28) with one cash row each, ascending. */
  function genMonthlyHistory(startYear: number, startMonth: number, count: number) {
    const snapshots: Array<{ dateKey: string; monthKey: string }> = [];
    const rows: DatedSnapshotHoldingRow[] = [];
    for (let i = 0; i < count; i++) {
      const total = startYear * 12 + (startMonth - 1) + i;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const dateKey = `${y}-${String(m).padStart(2, "0")}-28`;
      snapshots.push({ dateKey, monthKey: dateKey.slice(0, 7) });
      rows.push(
        row({ dateKey, holdingId: "a_cash", tier: "cash", valueMinor: 1_000_00 + i }),
      );
    }
    return { rows, snapshots };
  }

  test("'all' over a long history buckets coarser than monthly (density adapts)", () => {
    const { rows, snapshots } = genMonthlyHistory(2021, 1, 66); // 2021-01 .. 2026-06
    const series = buildCompositionSeries({
      housingHoldingIds: [],
      range: "all",
      rows,
      snapshots,
      today: "2026-06-28",
    });

    // 66 months, span 65 → quarterly: ~22 quarter closes, far fewer than 66.
    expect(series.length).toBeGreaterThanOrEqual(20);
    expect(series.length).toBeLessThanOrEqual(24);
    // The latest capture remains the open period at the right edge.
    expect(series.at(-1)!.dateKey).toBe("2026-06-28");
    expect(series.at(-1)!.isOpenPeriod).toBe(true);
  });

  test("'1y' windows to the last twelve months at monthly density", () => {
    const { rows, snapshots } = genMonthlyHistory(2021, 1, 66);
    const series = buildCompositionSeries({
      housingHoldingIds: [],
      range: "1y",
      rows,
      snapshots,
      today: "2026-06-28",
    });

    expect(series.map((p) => p.dateKey)).toEqual([
      "2025-07-28",
      "2025-08-28",
      "2025-09-28",
      "2025-10-28",
      "2025-11-28",
      "2025-12-28",
      "2026-01-28",
      "2026-02-28",
      "2026-03-28",
      "2026-04-28",
      "2026-05-28",
      "2026-06-28",
    ]);
  });

  test("omitting range defaults to 'all' — unchanged behavior for short histories", () => {
    const { rows, snapshots } = genMonthlyHistory(2026, 1, 6); // 6 months, monthly
    const series = buildCompositionSeries({
      housingHoldingIds: [],
      rows,
      snapshots,
      today: "2026-06-28",
    });

    expect(series.map((p) => p.dateKey)).toEqual([
      "2026-01-28",
      "2026-02-28",
      "2026-03-28",
      "2026-04-28",
      "2026-05-28",
      "2026-06-28",
    ]);
  });
});
