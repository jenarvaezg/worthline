/**
 * Pure hover logic of the composition chart (#143 follow-up): snapping the
 * cursor to the nearest period, the consolidated tooltip rows for a period, and
 * the short date label. Kept out of the client component so it is testable in
 * the node test environment.
 */
import type { CompositionPeriodGeometry } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  compositionTooltipRows,
  formatTooltipDate,
  nearestPeriodIndex,
} from "./composition-chart-hover";

function period(
  dateKey: string,
  bands: {
    cash?: number;
    market?: number;
    termLocked?: number;
    illiquid?: number;
    housing?: number;
  },
  debtMinor: number | null,
): CompositionPeriodGeometry {
  const value = (v: number | undefined): number => v ?? 0;
  const assetBands = [
    { band: "cash" as const, valueMinor: value(bands.cash), x: 0, y: 0 },
    { band: "market" as const, valueMinor: value(bands.market), x: 0, y: 0 },
    { band: "term-locked" as const, valueMinor: value(bands.termLocked), x: 0, y: 0 },
    { band: "illiquid" as const, valueMinor: value(bands.illiquid), x: 0, y: 0 },
    { band: "housing" as const, valueMinor: value(bands.housing), x: 0, y: 0 },
  ];
  const gross = assetBands.reduce((sum, b) => sum + b.valueMinor, 0);
  return {
    assetBands,
    dateKey,
    debt: debtMinor === null ? null : { valueMinor: debtMinor, x: 0, y: 0 },
    isOpenPeriod: false,
    netWorth: { valueMinor: gross - (debtMinor ?? 0), x: 0, y: 0 },
  };
}

describe("nearestPeriodIndex", () => {
  const xs = [4, 300, 596];

  test("snaps to the closest period by viewBox x", () => {
    expect(nearestPeriodIndex(xs, 4)).toBe(0);
    expect(nearestPeriodIndex(xs, 150)).toBe(0); // 146 vs 150 → still period 0
    expect(nearestPeriodIndex(xs, 160)).toBe(1); // 156 vs 140 → period 1
    expect(nearestPeriodIndex(xs, 596)).toBe(2);
  });

  test("clamps to the ends beyond the data range", () => {
    expect(nearestPeriodIndex(xs, -50)).toBe(0);
    expect(nearestPeriodIndex(xs, 10_000)).toBe(2);
  });
});

describe("compositionTooltipRows", () => {
  test("lists the five asset bands in order, then debt, then net worth", () => {
    const rows = compositionTooltipRows(
      period(
        "2026-05-31",
        {
          cash: 10_000_00,
          housing: 200_000_00,
          illiquid: 1_000_00,
          market: 5_000_00,
          termLocked: 3_000_00,
        },
        120_000_00,
      ),
    );

    expect(rows).toEqual([
      { kind: "asset", label: "Caja", valueMinor: 10_000_00 },
      { kind: "asset", label: "Mercado", valueMinor: 5_000_00 },
      { kind: "asset", label: "A plazo", valueMinor: 3_000_00 },
      { kind: "asset", label: "Ilíquido", valueMinor: 1_000_00 },
      { kind: "asset", label: "Vivienda", valueMinor: 200_000_00 },
      { kind: "debt", label: "Deudas", valueMinor: 120_000_00 },
      { kind: "net", label: "Patrimonio neto", valueMinor: 99_000_00 },
    ]);
  });

  test("omits the debt row when the period carries no debt", () => {
    const rows = compositionTooltipRows(period("2026-06-30", { cash: 12_000_00 }, null));

    expect(rows.some((row) => row.kind === "debt")).toBe(false);
    expect(rows.at(-1)).toEqual({
      kind: "net",
      label: "Patrimonio neto",
      valueMinor: 12_000_00,
    });
  });
});

describe("formatTooltipDate", () => {
  test("formats a date key as a short es-ES date", () => {
    expect(formatTooltipDate("2026-05-31")).toBe("31 may 2026");
    expect(formatTooltipDate("2026-01-01")).toBe("1 ene 2026");
  });
});
