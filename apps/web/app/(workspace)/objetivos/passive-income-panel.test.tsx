import type { PassiveIncomeLens } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { PassiveIncomePanel } from "./passive-income-panel";

const emptyLens: PassiveIncomeLens = {
  annualSpendingMinor: null,
  count: 0,
  coverageRatio: null,
  expensesMinor: 0,
  hasPayouts: false,
  netMinor: 0,
  totalMinor: 0,
  windowEndISO: "2026-09-01",
  windowStartISO: "2025-09-01",
};

function render(lens: PassiveIncomeLens): string {
  return renderToStaticMarkup(
    <PassiveIncomePanel
      currency="EUR"
      debtServiceCoherence={null}
      lens={lens}
      privacyMode={false}
    />,
  );
}

describe("PassiveIncomePanel", () => {
  test("the empty state opens the door it names (#1732)", () => {
    const markup = render(emptyLens);

    // Mandaba «a la ficha de cada activo» sin decir por dónde se llega a una.
    expect(markup).toContain('href="/patrimonio"');
    expect(markup).toContain("Cobros");
  });

  test("with payouts it prints the figure, not the CTA", () => {
    const markup = render({
      ...emptyLens,
      count: 3,
      hasPayouts: true,
      netMinor: 120_000,
      totalMinor: 120_000,
    });

    expect(markup).toContain("Cobros · últimos 12 meses");
    expect(markup).not.toContain('href="/patrimonio"');
  });
});
