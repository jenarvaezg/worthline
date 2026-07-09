/**
 * Journey 40: Per-holding benchmark comparison on the ficha (PRD #546 S5, #626).
 *
 * A market investment with a mapped tracked-index shows the vs-benchmark card on
 * `/patrimonio/[id]/editar`. Without control-plane prices the card degrades
 * honestly; with no tracked index assigned the card is omitted entirely.
 */

import { addHolding, expect, holdingRow, openAdvancedSettings, test } from "./fixtures";

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
  await openAdvancedSettings(page);

  const exposure = page.getByRole("region", { name: "Exposición" });
  await expect(exposure).toBeVisible();
  await exposure.locator('select[name="assetClass"]').selectOption("equity");
  await exposure.getByLabel("Índice de referencia").fill("MSCI World");
  await exposure.getByRole("button", { name: "Guardar exposición" }).click();
  await expect(page.getByRole("status")).toHaveText("Perfil de exposición guardado.");
  await openAdvancedSettings(page);

  const benchmark = page.getByLabel("Comparación con MSCI World");
  await expect(benchmark).toBeVisible();
  await expect(benchmark).toContainText("vs MSCI World");
  // A freshly added holding has no monthly-close history yet — the card degrades
  // honestly instead of fabricating a verdict (ADR 0060).
  await expect(benchmark).toContainText("La TWR necesita al menos dos cierres mensuales");
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
  await openAdvancedSettings(page);

  await expect(page.getByLabel(/Comparación con/)).toHaveCount(0);
});
