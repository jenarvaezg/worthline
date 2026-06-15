import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { CompositionSeriesPoint } from "@worthline/domain";

import CompositionChart from "./composition-chart";

function point(input: {
  dateKey: string;
  cash?: number;
  housing?: number;
  debts?: number;
  debtsSecuredByHousing?: number;
  isOpenPeriod?: boolean;
}): CompositionSeriesPoint {
  const cashMinor = input.cash ?? 0;
  const housingMinor = input.housing ?? 0;
  const debtsMinor = input.debts ?? 0;
  return {
    cashMinor,
    dateKey: input.dateKey,
    debtsMinor,
    debtsSecuredByHousingMinor: input.debtsSecuredByHousing ?? 0,
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
      <CompositionChart
        currency="EUR"
        points={[point({ cash: 100_00, dateKey: "2026-06-30" })]}
      />,
    );

    expect(markup).toContain("más capturas");
  });

  test("renders the five asset bands, an aggregated debt stack, the net-worth line and legend", () => {
    const markup = renderToStaticMarkup(
      <CompositionChart
        currency="EUR"
        points={[
          point({
            cash: 10_000_00,
            dateKey: "2026-05-31",
            debts: 120_000_00,
            housing: 200_000_00,
          }),
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
          point({
            cash: 10_000_00,
            dateKey: "2026-05-31",
            debts: 120_000_00,
            housing: 200_000_00,
          }),
          point({
            cash: 12_000_00,
            dateKey: "2026-06-30",
            housing: 200_000_00,
            isOpenPeriod: true,
          }),
        ]}
      />,
    );

    // Caja + Mercado → líquido; A plazo + Ilíquido → resto; Vivienda → vivienda.
    expect(markup).toContain('href="/?drill=liquid"');
    expect(markup).toContain('href="/?drill=rest"');
    expect(markup).toContain('href="/?drill=housing"');
    // Deudas stays a non-navigable legend entry with no destination.
    expect(markup).toContain('<span class="debt">');
    expect(markup).not.toContain("drill=debt");
  });

  test("offers a control to fold Vivienda out of the chart", () => {
    const markup = renderToStaticMarkup(
      <CompositionChart
        currency="EUR"
        points={[
          point({ cash: 10_000_00, dateKey: "2026-05-31", housing: 500_000_00 }),
          point({ cash: 12_000_00, dateKey: "2026-06-30", housing: 500_000_00 }),
        ]}
      />,
    );

    expect(markup).toContain("Ocultar vivienda");
  });

  test("links Deudas (legend + band) to the debts drilldown when given a destination (#145)", () => {
    const markup = renderToStaticMarkup(
      <CompositionChart
        currency="EUR"
        drillHrefs={{
          debts: "/?drill=debts",
          housing: "/?drill=housing",
          liquid: "/?drill=liquid",
          rest: "/?drill=rest",
        }}
        points={[
          point({
            cash: 10_000_00,
            dateKey: "2026-05-31",
            debts: 120_000_00,
            housing: 200_000_00,
          }),
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

    // The debt band and its legend entry now navigate to their own drilldown.
    expect(markup).toContain('href="/?drill=debts"');
    // The legend entry is a link now, not a bare span.
    expect(markup).not.toContain('<span class="debt">');
  });
});
