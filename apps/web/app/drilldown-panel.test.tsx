import type { DatedSnapshotHoldingRow, LiquidityTier } from "@worthline/domain";
import { buildDebtsDrilldown, buildLiquidDrilldown } from "@worthline/domain";
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
    countsAsHousing: false,
    kind: "liability",
    label,
    liquidityTier: tier,
    securesHousing: false,
    valueMinor,
  };
}

function assetRow(
  dateKey: string,
  holdingId: string,
  label: string,
  valueMinor: number,
  tier: LiquidityTier,
): DatedSnapshotHoldingRow {
  return {
    dateKey,
    holdingId,
    countsAsHousing: false,
    kind: "asset",
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
    // The aggregate series carries the synthetic "debts" band class — now drawn
    // as stacked bars in a <g> (this design pass), so the bars are <rect>s.
    expect(markup).toMatch(/drill(Band|Line) debts/);
    expect(markup).toContain("<rect");
    // Breadcrumb back to the composition, preserving the Vista.
    expect(markup).toContain('href="/?view=liquid#composicion"');
  });

  test("a debt no longer live is dropped from the cards entirely (no gone text)", () => {
    const drilldown = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage"], // l_card has left the portfolio
      rows,
    });

    const markup = renderToStaticMarkup(
      <DrilldownPanel backHref="/" currency="EUR" drilldown={drilldown} />,
    );

    // The retired card is gone, with no "Ya no vigente" / "Ya no en cartera"
    // copy anywhere (this design pass removed retired cards entirely).
    expect(markup).not.toContain("Tarjeta");
    expect(markup).not.toContain("Ya no vigente");
    expect(markup).not.toContain("Ya no en cartera");
    // The live mortgage card stays.
    expect(markup).toContain("Hipoteca");
  });
});

describe("DrilldownPanel — Papelera vs retired holdings (#268)", () => {
  test("a holding in the Papelera does not appear in the drill at all", () => {
    const drilldown = buildLiquidDrilldown({
      currentHoldingIds: ["a_live"],
      trashedHoldingIds: ["a_trashed"],
      rows: [
        assetRow("2026-06-01", "a_live", "Cuenta", 100, "cash"),
        assetRow("2026-06-03", "a_live", "Cuenta", 200, "cash"),
        assetRow("2026-06-01", "a_trashed", "Traspasada", 100, "market"),
        assetRow("2026-06-03", "a_trashed", "Traspasada", 200, "market"),
      ],
    });

    const markup = renderToStaticMarkup(
      <DrilldownPanel backHref="/" currency="EUR" drilldown={drilldown} />,
    );

    // Neither its label nor any "gone" tag — it is simply absent.
    expect(markup).not.toContain("Traspasada");
    expect(markup).not.toContain("Ya no en cartera");
    expect(markup).toContain("Cuenta");
  });

  test("a truly retired asset is dropped from the cards entirely (this design pass)", () => {
    const drilldown = buildLiquidDrilldown({
      currentHoldingIds: ["a_live"],
      trashedHoldingIds: [],
      rows: [
        assetRow("2026-06-01", "a_live", "Cuenta", 100, "cash"),
        assetRow("2026-06-03", "a_live", "Cuenta", 200, "cash"),
        assetRow("2026-06-01", "a_gone", "Retirada", 100, "market"),
        assetRow("2026-06-03", "a_gone", "Retirada", 200, "market"),
      ],
    });

    const markup = renderToStaticMarkup(
      <DrilldownPanel backHref="/" currency="EUR" drilldown={drilldown} />,
    );

    // No retired card, no gone copy — only the live holding's card remains.
    expect(markup).not.toContain("Retirada");
    expect(markup).not.toContain("Ya no en cartera");
    expect(markup).toContain("Cuenta");
  });

  test("each holding card renders a bar sparkline (<rect>s, not a polyline)", () => {
    const drilldown = buildLiquidDrilldown({
      currentHoldingIds: ["a_live"],
      rows: [
        assetRow("2026-06-01", "a_live", "Cuenta", 100, "cash"),
        assetRow("2026-06-03", "a_live", "Cuenta", 200, "cash"),
      ],
    });

    const markup = renderToStaticMarkup(
      <DrilldownPanel backHref="/" currency="EUR" drilldown={drilldown} />,
    );

    // The sparkline is now bars: a tier-classed svg with <rect>s. (The only
    // polyline left in the panel is the aggregate stack's total line, which
    // rides over the per-period bars — also part of this design pass.)
    expect(markup).toMatch(/drillSparkline cash/);
    expect(markup).toContain("<rect");
    expect(markup).toContain('class="drillTotalLine"');
  });
});
