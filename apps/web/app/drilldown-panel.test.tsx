import { buildDebtsDrilldown } from "@worthline/domain";
import type { DatedSnapshotHoldingRow } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import DrilldownPanel from "./drilldown-panel";

function liabilityRow(
  dateKey: string,
  holdingId: string,
  label: string,
  valueMinor: number,
  tier: "illiquid" | null = null,
): DatedSnapshotHoldingRow {
  return {
    dateKey,
    holdingId,
    kind: "liability",
    label,
    liquidityTier: tier,
    securesHousing: false,
    valueMinor,
  };
}

describe("DrilldownPanel — debts drilldown (#145)", () => {
  const rows = [
    liabilityRow("2026-04-30", "l_mortgage", "Hipoteca", 200_000_00, "illiquid"),
    liabilityRow("2026-05-31", "l_mortgage", "Hipoteca", 190_000_00, "illiquid"),
    liabilityRow("2026-06-30", "l_mortgage", "Hipoteca", 180_000_00, "illiquid"),
    liabilityRow("2026-04-30", "l_card", "Tarjeta", 1_000_00),
    liabilityRow("2026-05-31", "l_card", "Tarjeta", 1_500_00),
  ];

  test("renders the aggregate debt series, its title, each debt, and a Vista-preserving breadcrumb", () => {
    const drilldown = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage", "l_card"],
      housingHoldingIds: [],
      rows,
    });

    const markup = renderToStaticMarkup(
      <DrilldownPanel
        backHref="/?view=liquid#composicion"
        currency="EUR"
        drilldown={drilldown}
      />,
    );

    expect(markup).toContain("Deudas");
    expect(markup).toContain("Hipoteca");
    expect(markup).toContain("Tarjeta");
    // The aggregate series carries the synthetic "debts" band class.
    expect(markup).toMatch(/drill(Band|Line) debts/);
    // Breadcrumb back to the composition, preserving the Vista.
    expect(markup).toContain('href="/?view=liquid#composicion"');
  });

  test("a debt no longer live is kept and marked 'Ya no vigente'", () => {
    const drilldown = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage"], // l_card has left the portfolio
      housingHoldingIds: [],
      rows,
    });

    const markup = renderToStaticMarkup(
      <DrilldownPanel backHref="/" currency="EUR" drilldown={drilldown} />,
    );

    expect(markup).toContain("Ya no vigente");
  });
});
