/**
 * Journey 54: Per-holding benchmark comparison on the ficha (PRD #546 S5, #626).
 *
 * A market investment whose identity matches a global-catalog exposure profile
 * with a mapped tracked-index shows the vs-benchmark card on `/patrimonio/[id]/editar`.
 * Without monthly-close history the card degrades honestly; with no tracked index
 * in the catalog the card is omitted entirely.
 */

import { addHolding, expect, holdingRow, openFichaTab, test } from "./fixtures";

test("holding ficha shows vs-benchmark card when tracked index is assigned", async ({
  page,
}) => {
  await addHolding(page, {
    instrument: "etf",
    name: "ETF Benchmark S5",
    price: "100",
    symbol: "IWDA.AS",
  });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  await page.goto("/patrimonio");
  const row = holdingRow(page, "ETF Benchmark S5");
  await row.getByRole("link", { name: "ETF Benchmark S5" }).first().click();
  // The comparison sits with the returns, in «Rentabilidad» (#1826).
  await openFichaTab(page, "Rentabilidad");

  // On the fund's side, beside the TWR it compares (#1830).
  const benchmark = page
    .getByRole("region", { name: "El fondo TWR" })
    .getByLabel("Comparación con MSCI World");
  await expect(benchmark).toBeVisible();
  await expect(benchmark).toContainText("vs MSCI World");
  // A freshly added holding has no monthly-close history yet — the card degrades
  // honestly instead of fabricating a verdict (ADR 0060).
  await expect(benchmark).toContainText("No hay una TWR medible en este periodo");
});

test("holding ficha omits vs-benchmark when no tracked index is assigned", async ({
  page,
}) => {
  await addHolding(page, {
    instrument: "fund",
    name: "Fondo sin benchmark",
    price: "50",
  });
  await page.goto("/patrimonio");
  await holdingRow(page, "Fondo sin benchmark")
    .getByRole("link", { name: "Fondo sin benchmark" })
    .first()
    .click();
  // Asked where it would be, so its absence means something.
  await openFichaTab(page, "Rentabilidad");

  await expect(page.getByLabel(/Comparación con/)).toHaveCount(0);
});
