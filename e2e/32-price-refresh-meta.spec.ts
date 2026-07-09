/**
 * Journey 32: price-refresh metadata on a derived investment (issue #303).
 *
 * Surface, for an investment valued from the price cache, WHEN its unit price was
 * last refreshed and by WHICH source — on two existing surfaces (ADR 0009, zero
 * client JS):
 *   - the /patrimonio balance board enriches the derived-value badge's native
 *     `title` hover with a RELATIVE date + provider ("precio de hace 2 días, vía
 *     Yahoo"), alongside the existing "Valor calculado (unidades × precio)" text;
 *   - the holding detail (/patrimonio/[id]/editar) shows a VISIBLE caption with the
 *     ABSOLUTE date + provider ("Precio actualizado el … · Yahoo").
 *
 * The cached price is seeded directly through the store (no network): the spec
 * shares the run's DB via WORTHLINE_DB_PATH (set in playwright.config.ts), the same
 * seam global-setup.ts uses. The investment is created via the UI with a MANUAL
 * price first (so the asset + its id exist), then a `yahoo`-sourced cache row is
 * written for it — modelling a provider refresh without any external call.
 */

import { createWorthlineStore } from "@worthline/db";

import { addHolding, expect, holdingRow, test } from "./fixtures";

test("price refresh: board hover + detail caption show date + provider for a cached investment (#303)", async ({
  page,
}) => {
  // 1. Add the investment via the unified add route (manual price → no network).
  await addHolding(page, {
    instrument: "fund",
    name: "Fondo Refresh E2E",
    price: "100",
  });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // 2. Open its ficha to capture the generated asset id from the URL.
  await page.goto("/patrimonio");
  await holdingRow(page, "Fondo Refresh E2E")
    .getByRole("link", { name: "Fondo Refresh E2E" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  const assetId = page.url().match(/\/patrimonio\/([^/]+)\/editar/)![1]!;

  // 3. Seed a cached provider price for this asset (a yahoo refresh 2 days ago),
  //    writing straight to the run's DB through the store — the same seam the
  //    global setup uses. Two whole days back so the relative phrase is stable.
  const databasePath = process.env.WORTHLINE_DB_PATH!;
  const fetchedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const store = await createWorthlineStore({ databasePath });
  await store.operations.upsertPrice({
    assetId,
    currency: "EUR",
    fetchedAt,
    freshnessState: "fresh",
    price: "100",
    source: "yahoo",
  });
  store.close();

  // 4. Board hover: the derived-value badge's native title now carries BOTH the
  //    existing "Valor calculado" text and the relative refresh date + provider.
  await page.goto("/patrimonio");
  const badge = holdingRow(page, "Fondo Refresh E2E").locator("abbr.balanceCalc");
  await expect(badge).toHaveAttribute(
    "title",
    "Valor calculado (unidades × precio) · precio de hace 2 días, vía Yahoo",
  );

  // 5. Detail caption: opening the ficha shows the visible absolute date + provider
  //    next to the unit price (es-ES "D mmm YYYY"), inside the operations context.
  await holdingRow(page, "Fondo Refresh E2E")
    .getByRole("link", { name: "Fondo Refresh E2E" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  const ctx = page.locator(".operacionContext");
  await expect(ctx).toContainText(/Precio actualizado el \d{1,2} \w+\.? \d{4} · Yahoo/);
});
