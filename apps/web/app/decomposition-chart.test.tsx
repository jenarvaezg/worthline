import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { NetWorthSnapshot } from "@worthline/domain";

import DecompositionChart from "./decomposition-chart";

function snapshot(input: {
  id: string;
  dateKey: string;
  totalMinor: number;
  liquidMinor: number;
  housingMinor: number;
}): NetWorthSnapshot {
  const total = { amountMinor: input.totalMinor, currency: "EUR" } as const;

  return {
    capturedAt: `${input.dateKey}T12:00:00.000Z`,
    dateKey: input.dateKey,
    debts: { ...total, amountMinor: 0 },
    grossAssets: total,
    housingEquity: { amountMinor: input.housingMinor, currency: "EUR" },
    id: input.id,
    isMonthlyClose: false,
    liquidNetWorth: { amountMinor: input.liquidMinor, currency: "EUR" },
    monthKey: input.dateKey.slice(0, 7),
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: total,
    warnings: [],
  };
}

describe("DecompositionChart", () => {
  test("renders native hover titles with date, band, and value", () => {
    const markup = renderToStaticMarkup(
      <DecompositionChart
        snapshots={[
          snapshot({
            dateKey: "2026-06-01",
            housingMinor: 50_000_00,
            id: "s1",
            liquidMinor: 10_000_00,
            totalMinor: 65_000_00,
          }),
          snapshot({
            dateKey: "2026-06-12",
            housingMinor: 52_000_00,
            id: "s2",
            liquidMinor: 11_000_00,
            totalMinor: 68_000_00,
          }),
        ]}
      />,
    );

    expect(markup).toContain("2026-06-01 · Vivienda: 50.000");
    expect(markup).toContain("2026-06-12 · Líquido: 11.000");
    expect(markup).toContain("2026-06-12 · Resto: 5000");
  });
});
