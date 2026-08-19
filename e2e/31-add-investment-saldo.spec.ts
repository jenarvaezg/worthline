/**
 * Journey 31: the simple «Una inversión» drawer (PRD #593 S2, #597).
 *
 * The wizard's investment drawer: pick one of the 3 behavior groups → search (or
 * type the symbol by hand — the manual fallback used here to avoid live network)
 * → capture "how much you have" via one of two MUTUALLY-EXCLUSIVE modes:
 *   (a) saldo-de-hoy → derives units + records an opening BUY, lands VALUED.
 *   (b) importar extracto → no synthetic opening, routes to «Cargar movimientos».
 *
 * Runs after journey 30 so the holdings it adds don't perturb earlier totals.
 */

import { expect, holdingRow, openAdvancedSettings, test } from "./fixtures";

/** Open the investment drawer and select one of the 3 behavior groups. */
async function openInvestmentGroup(
  page: import("@playwright/test").Page,
  instrument: string,
) {
  await page.goto("/patrimonio/anadir");
  await expect(
    page.getByRole("heading", { name: "Añade algo a tu patrimonio" }),
  ).toBeVisible();
  await page.locator('label.simpleDrawerCard:has(input[value="inversion"])').click();
  await page
    .locator(`label:has(input[name="instrument"][value="${instrument}"])`)
    .click();
}

test("saldo-de-hoy: crypto → opening BUY, lands valued, shows ≈ participaciones", async ({
  page,
}) => {
  await openInvestmentGroup(page, "crypto");

  await page.locator('input[name="name_crypto"]').fill("Bitcoin saldo E2E");
  await page.locator('input[name="symbol_crypto"]').fill("bitcoin");

  // Scope to the chosen group: the saldo sub-pane (and its hint) exists once per
  // group in the DOM, so target the crypto group's to avoid a strict-mode match.
  const saldoPane = page.locator(
    '.invGroupPane[data-group="crypto"] .invModePane[data-mode="saldo"]',
  );
  await saldoPane.locator('input[name="price_crypto"]').fill("50.000,00");
  await saldoPane.locator('input[name="saldo_crypto"]').fill("1.000,00");

  // The live hint reacts as the saldo is typed: 1000 / 50000 = 0,02.
  await expect(saldoPane.locator(".invUnitsHint")).toContainText("participaciones");
  await expect(saldoPane.locator(".invUnitsHint")).toContainText("0,02");

  // «¿Desde cuándo la tienes?» (#1395, #1490): dating the position in the past makes
  // the hint announce the history rebuild, and says that without a cost the rebuild
  // runs at today's price. Cleared before submitting, so this journey keeps adding a
  // holding dated today and the later journeys' totals stay as they are — the WRITE
  // side of a backdated alta (the opening's executed_at and the rippled snapshot) is
  // covered at the action level instead.
  const saldoDate = saldoPane.locator('input[name="saldoDate_crypto"]');
  await saldoDate.fill("2026-01-15");
  await expect(saldoPane.locator(".invUnitsHint")).toContainText("histórico");
  await expect(saldoPane).toContainText("Sin coste no habrá plusvalía");
  await expect(saldoPane).toContainText("15 ene 2026");

  // The acquisition cost (#1490): what the position COST, read back as a unit price
  // and as the latent gain it reveals — 1.000,00 € worth today bought for 800,00 €.
  await saldoPane.locator('input[name="cost_crypto"]').fill("800,00");
  await expect(saldoPane).toContainText("plusvalía latente");
  await expect(saldoPane).toContainText("200,00");
  await saldoPane.locator('input[name="cost_crypto"]').fill("");

  await saldoDate.fill("");
  await expect(saldoPane.locator(".invUnitsHint")).toContainText("0,02");

  await saldoPane.getByRole("button", { name: "Añadir" }).click();

  // S5 (#600): the simple wizard loops — the add lands on the success screen
  // (not the list), showing the running net worth + the loop CTAs.
  await expect(page).toHaveURL(/\/patrimonio\/anadir\?ok=investment_added/);
  await expect(page.getByRole("heading", { name: /Inversión añadida/ })).toBeVisible();
  await expect(page.locator(".addSuccessTotal")).toContainText("Patrimonio neto");

  // «Ver mi patrimonio» exits the loop to the holdings list, where the new
  // investment (valued via its opening BUY) is listed.
  await page.getByRole("link", { name: /Ver mi patrimonio/ }).click();
  await expect(page).toHaveURL(/\/patrimonio(\?|$)/);
  await expect(holdingRow(page, "Bitcoin saldo E2E")).toBeVisible();
});

test("importar extracto: routes to «Cargar movimientos» with no opening operation", async ({
  page,
}) => {
  await openInvestmentGroup(page, "fund");

  await page.locator('input[name="name_fund"]').fill("Fondo import E2E");
  await page.locator('input[name="symbol_fund"]').fill("VANGTLI");

  await page.locator('label:has(input[name="invMode_fund"][value="import"])').click();

  const importPane = page.locator('.invModePane[data-mode="import"]');
  await importPane.getByRole("button", { name: "Añadir" }).click();

  // Routed to the holding's ficha, where «Cargar movimientos» lives (#173).
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/, { timeout: 10_000 });
  await expect(page.getByRole("status")).toContainText("carga el extracto");
  await openAdvancedSettings(page);
  await expect(page.getByRole("heading", { name: "Cargar movimientos" })).toBeVisible();

  // No opening operation was invented — the operations list is empty.
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();
});

test("submit errors keep the current scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await openInvestmentGroup(page, "crypto");

  const saldoPane = page.locator(
    '.invGroupPane[data-group="crypto"] .invModePane[data-mode="saldo"]',
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);

  await saldoPane.getByRole("button", { name: "Añadir" }).click();

  await expect(page.locator(".errorBand")).toContainText("precio por unidad");
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(before - 20);
});
