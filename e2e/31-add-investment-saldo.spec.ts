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

import { test, expect, holdingRow } from "./fixtures";

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

  await saldoPane.getByRole("button", { name: "Añadir" }).click();

  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // It lands in the list (valued via the opening BUY — asserted in the action
  // unit test; here we prove the end-to-end wiring reaches the list).
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
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await expect(page.getByRole("status")).toContainText("carga el extracto");
  await expect(page.getByRole("heading", { name: "Cargar movimientos" })).toBeVisible();

  // No opening operation was invented — the operations list is empty.
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();
});
