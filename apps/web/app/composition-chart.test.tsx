import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { CompositionSeriesPoint } from "@worthline/domain";

import CompositionChart from "./composition-chart";

function point(input: {
  dateKey: string;
  cash?: number;
  housing?: number;
  debts?: number;
  isOpenPeriod?: boolean;
}): CompositionSeriesPoint {
  const cashMinor = input.cash ?? 0;
  const housingMinor = input.housing ?? 0;
  const debtsMinor = input.debts ?? 0;
  return {
    cashMinor,
    dateKey: input.dateKey,
    debtsMinor,
    housingMinor,
    illiquidMinor: 0,
    isOpenPeriod: input.isOpenPeriod ?? false,
    marketMinor: 0,
    netWorthMinor: cashMinor + housingMinor - debtsMinor,
    termLockedMinor: 0,
  };
}

describe("CompositionChart", () => {
  test("shows an empty-state message below the two-point threshold", () => {
    const markup = renderToStaticMarkup(
      <CompositionChart currency="EUR" points={[point({ cash: 100_00, dateKey: "2026-06-30" })]} />,
    );

    expect(markup).toContain("más capturas");
  });

  test("renders the five asset bands, an aggregated debt stack, the net-worth line and legend", () => {
    const markup = renderToStaticMarkup(
      <CompositionChart
        currency="EUR"
        points={[
          point({ cash: 10_000_00, dateKey: "2026-05-31", debts: 120_000_00, housing: 200_000_00 }),
          point({
            cash: 12_000_00,
            dateKey: "2026-06-30",
            debts: 118_000_00,
            housing: 200_000_00,
            isOpenPeriod: true,
          }),
        ]}
      />,
    );

    // Legend names every band with page-wide color semantics.
    expect(markup).toContain("Caja");
    expect(markup).toContain("Vivienda");
    expect(markup).toContain("Deudas");
    // Five asset bands above zero + one aggregated debt stack below.
    expect(markup).toContain("compositionBand housing");
    expect(markup).toContain("compositionDebt");
    // The net-worth line carries a native hover title in es-ES money for the
    // finalized close (net = 10.000 + 200.000 − 120.000 = 90.000).
    expect(markup).toContain("2026-05-31 · Patrimonio neto: 90.000");
  });

  test("exposes native hover with period, label and value on each band, debt and the net line", () => {
    const markup = renderToStaticMarkup(
      <CompositionChart
        currency="EUR"
        points={[
          point({ cash: 10_000_00, dateKey: "2026-05-31", debts: 120_000_00, housing: 200_000_00 }),
          point({ cash: 12_000_00, dateKey: "2026-06-30", housing: 200_000_00, isOpenPeriod: true }),
        ]}
      />,
    );

    // Each asset component, per period.
    expect(markup).toContain("2026-05-31 · Caja: 10.000");
    expect(markup).toContain("2026-05-31 · Vivienda: 200.000");
    // The aggregated debt band.
    expect(markup).toContain("2026-05-31 · Deudas: 120.000");
    // The net-worth line — for BOTH the finalized close and the open period.
    expect(markup).toContain("2026-05-31 · Patrimonio neto: 90.000");
    expect(markup).toContain("2026-06-30 · Patrimonio neto: 212.000");
  });

  test("legend and asset bands link to their drilldown; Deudas has no destination", () => {
    const markup = renderToStaticMarkup(
      <CompositionChart
        currency="EUR"
        drillHrefs={{
          housing: "/?drill=housing",
          liquid: "/?drill=liquid",
          rest: "/?drill=rest",
        }}
        points={[
          point({ cash: 10_000_00, dateKey: "2026-05-31", debts: 120_000_00, housing: 200_000_00 }),
          point({ cash: 12_000_00, dateKey: "2026-06-30", housing: 200_000_00, isOpenPeriod: true }),
        ]}
      />,
    );

    // Caja + Mercado → líquido; A plazo + Ilíquido → resto; Vivienda → vivienda.
    expect(markup).toContain('href="/?drill=liquid"');
    expect(markup).toContain('href="/?drill=rest"');
    expect(markup).toContain('href="/?drill=housing"');
    // Deudas stays a non-navigable legend entry with no destination.
    expect(markup).toContain('<span class="debt">');
    expect(markup).not.toContain('drill=debt');
  });
});
