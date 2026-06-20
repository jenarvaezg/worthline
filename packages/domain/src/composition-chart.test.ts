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
  securesHousing?: boolean;
  countsAsHousing?: boolean;
}): DatedSnapshotHoldingRow {
  return {
    countsAsHousing: input.countsAsHousing ?? false,
    dateKey: input.dateKey ?? "2026-06-30",
    holdingId: input.holdingId,
    kind: input.kind ?? "asset",
    label: input.holdingId,
    liquidityTier: input.tier,
    securesHousing: input.securesHousing ?? false,
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
  const debtsSecuredByHousingMinor = bands.debtsSecuredByHousingMinor ?? 0;
  return {
    cashMinor,
    dateKey,
    debtsMinor,
    debtsSecuredByHousingMinor,
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
    const bands = deriveCompositionBands([
      row({ holdingId: "a_cash", tier: "cash", valueMinor: 100_00 }),
      row({ holdingId: "l_card", tier: null, valueMinor: 30_00, kind: "liability" }),
    ]);

    expect(bands).toEqual({
      cashMinor: 100_00,
      debtsMinor: 30_00,
      debtsSecuredByHousingMinor: 0,
      housingMinor: 0,
      illiquidMinor: 0,
      marketMinor: 0,
      netWorthMinor: 70_00,
      termLockedMinor: 0,
    });
  });

  test("buckets a post-migration house onto the housing rung; art on illiquid, never double-counting", () => {
    // After the v28 recut a house freezes with liquidityTier 'housing' (ADR 0022).
    const bands = deriveCompositionBands([
      row({ holdingId: "a_house", tier: "housing", valueMinor: 300_000_00 }),
      row({ holdingId: "a_art", tier: "illiquid", valueMinor: 20_000_00 }),
    ]);

    expect(bands.housingMinor).toBe(300_000_00);
    expect(bands.illiquidMinor).toBe(20_000_00);
  });

  test("defensive: a pre-migration house (frozen illiquid but countsAsHousing) still buckets to housing", () => {
    // Historical rows captured before the recut carry liquidityTier 'illiquid' yet
    // countsAsHousing true; the band derivation falls back to countsAsHousing so the
    // chart never double-counts a legacy house into the illiquid rung.
    const bands = deriveCompositionBands([
      row({
        holdingId: "a_house",
        tier: "illiquid",
        valueMinor: 300_000_00,
        countsAsHousing: true,
      }),
      row({ holdingId: "a_art", tier: "illiquid", valueMinor: 20_000_00 }),
    ]);

    expect(bands.housingMinor).toBe(300_000_00);
    expect(bands.illiquidMinor).toBe(20_000_00);
  });

  test("five asset bands partition gross assets; net worth = gross − debts", () => {
    const rows = [
      row({ holdingId: "a_cash", tier: "cash", valueMinor: 10_000_00 }),
      row({ holdingId: "a_fund", tier: "market", valueMinor: 50_000_00 }),
      row({ holdingId: "a_pension", tier: "term-locked", valueMinor: 30_000_00 }),
      row({ holdingId: "a_art", tier: "illiquid", valueMinor: 5_000_00 }),
      row({ holdingId: "a_house", tier: "housing", valueMinor: 250_000_00 }),
      row({
        holdingId: "l_mortgage",
        tier: "housing",
        valueMinor: 120_000_00,
        kind: "liability",
      }),
    ];

    const bands = deriveCompositionBands(rows);
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

  test("carves housing-secured debt into its own breakdown while debts still sum ALL liabilities (ADR 0008)", () => {
    const bands = deriveCompositionBands([
      row({ holdingId: "a_cash", tier: "cash", valueMinor: 100_00 }),
      row({ holdingId: "a_house", tier: "housing", valueMinor: 300_000_00 }),
      row({
        holdingId: "l_mortgage",
        tier: "housing",
        valueMinor: 120_000_00,
        kind: "liability",
        securesHousing: true,
      }),
      row({
        holdingId: "l_card",
        tier: null,
        valueMinor: 5_000_00,
        kind: "liability",
        securesHousing: false,
      }),
    ]);

    // The carve mirrors the housing asset carve: it is a breakdown, not a
    // replacement — `debtsMinor` still aggregates EVERY liability so the
    // reconciliation identity (ADR 0008) is untouched.
    expect(bands.debtsSecuredByHousingMinor).toBe(120_000_00);
    expect(bands.debtsMinor).toBe(125_000_00);
    expect(bands.netWorthMinor).toBe(300_100_00 - 125_000_00);
  });

  test("housing-secured carve keys off securesHousing, NOT type/tier (ADR 0013): an unsecured illiquid debt stays out", () => {
    const bands = deriveCompositionBands([
      row({ holdingId: "a_house", tier: "housing", valueMinor: 300_000_00 }),
      // Illiquid rung but NOT securing housing — must not be carved.
      row({
        holdingId: "l_loan",
        tier: "illiquid",
        valueMinor: 10_000_00,
        kind: "liability",
        securesHousing: false,
      }),
    ]);

    expect(bands.debtsSecuredByHousingMinor).toBe(0);
    expect(bands.debtsMinor).toBe(10_000_00);
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

  test("categorical slots draw even though two points share a date (no time axis)", () => {
    // The chart is a column chart: one equal slot per period regardless of dates,
    // so two same-day captures still render two side-by-side columns rather than
    // collapsing to a degenerate zero-length time span.
    const geometry = buildCompositionChartGeometry([
      seriesPoint("2026-06-30", { cashMinor: 100_00 }),
      seriesPoint("2026-06-30", { cashMinor: 200_00 }),
    ]);

    expect(geometry).not.toBeNull();
    expect(geometry!.periods).toHaveLength(2);
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

    // "gross" keeps the home + full debt separate, so the stack matches the raw
    // bands and the debt depth is the full balance.
    const geometry = buildCompositionChartGeometry(points, { housingMode: "gross" })!;

    expect(geometry.assetBands.map((band) => band.band)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
    // Each band emits one bar RECTANGLE per period, index-aligned with periods.
    expect(geometry.assetBands[0]!.bars).toHaveLength(2);
    expect(geometry.assetBands.every((band) => band.bars.length === points.length)).toBe(
      true,
    );
    // Debt present anywhere → per-period debt rectangles below the baseline.
    expect(geometry.debtBars).not.toBeNull();
    expect(geometry.debtBars).toHaveLength(2);
    // Debt rects sit at or below the baseline (debts stack downward).
    expect(geometry.debtBars!.every((bar) => bar.y >= geometry.baselineY - 0.01)).toBe(
      true,
    );
    // Asset bars are centred on the period x with a positive width.
    expect(geometry.assetBands[0]!.bars[0]!.width).toBeGreaterThan(0);
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

  test("draws even categorical slots with uniform bar widths, ignoring date spacing", () => {
    // Deliberately irregular date gaps (1 day, then ~6 months): a time axis would
    // crowd the first pair and stretch the last. The column chart instead puts one
    // EQUAL slot per period — uniform spacing and uniform width regardless.
    const points = [
      seriesPoint("2026-01-01", { cashMinor: 100_00 }),
      seriesPoint("2026-01-02", { cashMinor: 120_00 }),
      seriesPoint("2026-06-30", { cashMinor: 140_00 }),
    ];

    const geometry = buildCompositionChartGeometry(points, { housingMode: "gross" })!;

    const n = points.length;
    const insetX = 4; // COMPOSITION_CHART_INSET_X
    const width = 600; // COMPOSITION_CHART_WIDTH
    const slotW = (width - 2 * insetX) / n;
    const expectedXs = points.map((_, i) => insetX + slotW * (i + 0.5));
    const expectedBarWidth = slotW * 0.85;

    // Period x-centres are the even categorical slots (half-slot margins at edges).
    const xs = geometry.periods.map((p) => p.netWorth.x);
    xs.forEach((x, i) => expect(x).toBeCloseTo(expectedXs[i]!, 2));

    // Adjacent gaps are all identical (one equal slot wide) — no crowding.
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    gaps.forEach((gap) => expect(gap).toBeCloseTo(slotW, 2));

    // Every bar across every band shares the one uniform slot-derived width.
    const allBars = geometry.assetBands.flatMap((band) => band.bars);
    for (const bar of allBars) {
      expect(bar.width).toBeCloseTo(expectedBarWidth, 2);
    }

    // No bar ever clips the viewBox: half-slot margins keep the first bar's left
    // edge ≥ 0 and the last bar's right edge ≤ width.
    const firstBar = geometry.assetBands[0]!.bars[0]!;
    const lastBar = geometry.assetBands[0]!.bars.at(-1)!;
    expect(firstBar.x).toBeGreaterThanOrEqual(0);
    expect(lastBar.x + lastBar.width).toBeLessThanOrEqual(width);

    // The net-worth line rides over the same categorical centres as the bars.
    const lineXs = parseCoords(geometry.netWorthLine).map((c) => c.x);
    lineXs.forEach((x, i) => expect(x).toBeCloseTo(expectedXs[i]!, 2));
  });

  test("default housingMode is 'net': folds the securing mortgage into a Vivienda equity band", () => {
    const points = [
      seriesPoint("2026-05-31", {
        cashMinor: 10_000_00,
        housingMinor: 300_000_00,
        debtsMinor: 205_000_00,
        debtsSecuredByHousingMinor: 200_000_00,
      }),
      seriesPoint("2026-06-30", {
        cashMinor: 10_000_00,
        housingMinor: 300_000_00,
        debtsMinor: 205_000_00,
        debtsSecuredByHousingMinor: 200_000_00,
      }),
    ];

    const net = buildCompositionChartGeometry(points)!; // default
    const gross = buildCompositionChartGeometry(points, { housingMode: "gross" })!;

    // (a) The net-worth LINE is identical across gross/net — folding the mortgage
    // is a pure rearrangement (ADR 0008 reconciliation invariant). 300k+10k−205k.
    expect(net.periods.map((p) => p.netWorth.valueMinor)).toEqual([
      105_000_00, 105_000_00,
    ]);
    expect(net.periods.map((p) => p.netWorth.valueMinor)).toEqual(
      gross.periods.map((p) => p.netWorth.valueMinor),
    );

    // (b) The Vivienda band value = gross housing − securing debt (equity), and
    // the below-baseline debt drops that securing portion (only the 5k unsecured
    // remainder survives below the line).
    const netHousing = net.periods[0]!.assetBands.find((b) => b.band === "housing")!;
    expect(netHousing.valueMinor).toBe(100_000_00); // 300k − 200k
    expect(
      gross.periods[0]!.assetBands.find((b) => b.band === "housing")!.valueMinor,
    ).toBe(300_000_00);
    expect(net.periods[0]!.debt!.valueMinor).toBe(5_000_00); // 205k − 200k
    expect(gross.periods[0]!.debt!.valueMinor).toBe(205_000_00);
  });

  test("'net' clamps an underwater home to a zero-height equity band but keeps the reconciled net line", () => {
    // House worth less than the mortgage securing it: equity is negative.
    const points = [
      seriesPoint("2026-05-31", {
        cashMinor: 50_000_00,
        housingMinor: 100_000_00,
        debtsMinor: 150_000_00,
        debtsSecuredByHousingMinor: 150_000_00,
      }),
      seriesPoint("2026-06-30", {
        cashMinor: 50_000_00,
        housingMinor: 100_000_00,
        debtsMinor: 150_000_00,
        debtsSecuredByHousingMinor: 150_000_00,
      }),
    ];

    const net = buildCompositionChartGeometry(points)!;

    // The drawn equity band clamps to 0 (no inverted bar), but the net-worth line
    // still reconciles to the true 50k+100k−150k = 0 (invariant preserved).
    expect(net.periods[0]!.assetBands.find((b) => b.band === "housing")!.valueMinor).toBe(
      0,
    );
    expect(net.periods[0]!.netWorth.valueMinor).toBe(0);
    // Below-baseline debt is the unsecured remainder only (here zero) → no stack.
    expect(net.periods[0]!.debt).toBeNull();
  });

  test("'hidden' housingMode matches the legacy excludedBands:['housing'] behaviour exactly", () => {
    const points = [
      seriesPoint("2026-05-31", {
        cashMinor: 10_000_00,
        housingMinor: 500_000_00,
        debtsMinor: 205_000_00,
        debtsSecuredByHousingMinor: 200_000_00,
      }),
      seriesPoint("2026-06-30", {
        cashMinor: 10_000_00,
        housingMinor: 500_000_00,
        debtsMinor: 205_000_00,
        debtsSecuredByHousingMinor: 200_000_00,
      }),
    ];

    const hidden = buildCompositionChartGeometry(points, { housingMode: "hidden" })!;
    const excluded = buildCompositionChartGeometry(points, {
      excludedBands: ["housing"],
    })!;

    // Same shown bands, same debt depth, same net line, same y-domain.
    expect(hidden.assetBands.map((b) => b.band)).toEqual(
      excluded.assetBands.map((b) => b.band),
    );
    expect(hidden.assetBands.some((b) => b.band === "housing")).toBe(false);
    expect(hidden.periods.map((p) => p.debt?.valueMinor ?? null)).toEqual(
      excluded.periods.map((p) => p.debt?.valueMinor ?? null),
    );
    expect(hidden.periods.map((p) => p.netWorth.valueMinor)).toEqual(
      excluded.periods.map((p) => p.netWorth.valueMinor),
    );
    expect(hidden.yMin).toBeCloseTo(excluded.yMin, 5);
    expect(hidden.yMax).toBeCloseTo(excluded.yMax, 5);
    // The shed net is the non-housing net: 10k − 5k unsecured = 5k.
    expect(hidden.periods[0]!.netWorth.valueMinor).toBe(5_000_00);
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

  test("excluding housing also drops the housing-secured debt: stack, net line, y-domain and anchors all shed it", () => {
    const points = [
      seriesPoint("2026-05-31", {
        cashMinor: 10_000_00,
        housingMinor: 500_000_00,
        debtsMinor: 205_000_00,
        debtsSecuredByHousingMinor: 200_000_00,
      }),
      seriesPoint(
        "2026-06-30",
        {
          cashMinor: 10_000_00,
          housingMinor: 500_000_00,
          debtsMinor: 205_000_00,
          debtsSecuredByHousingMinor: 200_000_00,
        },
        true,
      ),
    ];

    // "gross" shows the home and full debt separately — the baseline to compare
    // the hidden carve against.
    const full = buildCompositionChartGeometry(points, { housingMode: "gross" })!;
    const exHousing = buildCompositionChartGeometry(points, {
      excludedBands: ["housing"],
    })!;

    // With everything shown the debt stack spans the full 205k below the baseline.
    expect(full.periods[0]!.debt!.valueMinor).toBe(205_000_00);
    expect(full.debtBars).not.toBeNull();

    // Hiding housing carves the 200k housing-secured slice out of the debt stack —
    // only the 5k unsecured remainder survives, mirroring the asset-side carve.
    expect(exHousing.periods[0]!.debt!.valueMinor).toBe(5_000_00);
    expect(exHousing.periods[1]!.debt!.valueMinor).toBe(5_000_00);

    // Net worth recomputes as Σ shown assets − Σ shown debts = 10k − 5k = 5k
    // (NOT 500k+10k−205k), at EVERY period.
    expect(exHousing.periods[0]!.netWorth.valueMinor).toBe(5_000_00);
    expect(exHousing.periods[1]!.netWorth.valueMinor).toBe(5_000_00);

    // The y-domain rescales to the remaining 10k-scale bands (no 500k dead space,
    // no 205k debt depth). The deepest point is now the 5k debt, not 205k.
    expect(exHousing.yMin).toBeGreaterThan(full.yMin / 10);
    expect(-exHousing.yMin).toBeLessThan(50_000_00);

    // The net line maps the shed net worth through the rescaled domain.
    const lineCoords = parseCoords(exHousing.netWorthLine);
    expect(lineCoords[0]!.y).toBeCloseTo(
      yFor(5_000_00, exHousing.yMin, exHousing.yMax),
      2,
    );
  });

  test("excluding housing with zero housing-secured debt leaves the debt stack intact (only the asset band vanishes)", () => {
    // A property with no associated debt: the household carries only unsecured
    // card debt, which must remain in full when housing is hidden.
    const points = [
      seriesPoint("2026-05-31", {
        cashMinor: 10_000_00,
        housingMinor: 300_000_00,
        debtsMinor: 5_000_00,
        debtsSecuredByHousingMinor: 0,
      }),
      seriesPoint("2026-06-30", {
        cashMinor: 12_000_00,
        housingMinor: 300_000_00,
        debtsMinor: 5_000_00,
        debtsSecuredByHousingMinor: 0,
      }),
    ];

    const exHousing = buildCompositionChartGeometry(points, {
      excludedBands: ["housing"],
    })!;

    // Asset band gone, but the unsecured debt stack is untouched.
    expect(exHousing.assetBands.some((b) => b.band === "housing")).toBe(false);
    expect(exHousing.periods[0]!.debt!.valueMinor).toBe(5_000_00);
    // Net = cash − unsecured debt = 10k − 5k.
    expect(exHousing.periods[0]!.netWorth.valueMinor).toBe(5_000_00);
  });

  test("household with no housing at all: hiding housing is a no-op for the debt stack (behaves exactly as today)", () => {
    const points = [
      seriesPoint("2026-05-31", { cashMinor: 10_000_00, debtsMinor: 3_000_00 }),
      seriesPoint("2026-06-30", { cashMinor: 11_000_00, debtsMinor: 3_000_00 }),
    ];

    const full = buildCompositionChartGeometry(points)!;
    const exHousing = buildCompositionChartGeometry(points, {
      excludedBands: ["housing"],
    })!;

    // No housing-secured debt to carve → the debt stack and net worth are
    // identical with or without the toggle.
    expect(exHousing.periods[0]!.debt!.valueMinor).toBe(
      full.periods[0]!.debt!.valueMinor,
    );
    expect(exHousing.periods[0]!.netWorth.valueMinor).toBe(
      full.periods[0]!.netWorth.valueMinor,
    );
    expect(exHousing.periods[0]!.netWorth.valueMinor).toBe(7_000_00);
  });

  test("no debt in any period → no debt stack and no debt hover anchor", () => {
    const geometry = buildCompositionChartGeometry([
      seriesPoint("2026-05-31", { cashMinor: 100_00 }),
      seriesPoint("2026-06-30", { cashMinor: 120_00 }),
    ])!;

    expect(geometry.debtBars).toBeNull();
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
