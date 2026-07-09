/**
 * Journey 30: the unified «Añadir holding» flow (PRD #146 S5, #151).
 *
 * Instrument-first add: pick an instrument from the gallery → its form + the
 * "Se creará" readout disclose inline (pure CSS :has(), no JS) → submit creates a
 * correct holding end-to-end. One case per family (stored asset, appreciating
 * property, derived investment, debt) to prove the dispatch. Runs last so the
 * holdings it adds don't perturb earlier journeys' totals.
 */

import { expect, holdingRow, test } from "./fixtures";

/** Pick an instrument by clicking its gallery chip (the radio is visually hidden). */
async function pickInstrument(page: import("@playwright/test").Page, instrument: string) {
  await page.goto("/patrimonio/anadir/avanzado");
  await expect(page.getByRole("heading", { name: /Añadir holding/ })).toBeVisible();
  await page.locator(`label.addHoldingChip:has(input[value="${instrument}"])`).click();
}

test("stored asset: current_account → Activo añadido on the cash rung", async ({
  page,
}) => {
  await pickInstrument(page, "current_account");

  await page.locator('input[name="name_current_account"]').fill("Cuenta unificada");
  await page.locator('input[name="value_current_account"]').fill("2500");

  await page.getByRole("button", { name: "Añadir al patrimonio" }).click();

  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");
  await expect(holdingRow(page, "Cuenta unificada")).toBeVisible();
});

test("appreciating: property → Activo añadido with acquisition", async ({ page }) => {
  await pickInstrument(page, "property");

  await page.locator('input[name="name_property"]').fill("Piso unificado");
  await page.locator('input[name="acqDate_property"]').fill("2020-01-15");
  await page.locator('input[name="acqValue_property"]').fill("180000");

  await page.getByRole("button", { name: "Añadir al patrimonio" }).click();

  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");
  await expect(holdingRow(page, "Piso unificado")).toBeVisible();
});

test("derived investment: stock → Inversión añadida", async ({ page }) => {
  await pickInstrument(page, "stock");

  await page.locator('input[name="name_stock"]').fill("Acción unificada");
  await page.locator('input[name="symbol_stock"]').fill("AAPL");

  await page.getByRole("button", { name: "Añadir al patrimonio" }).click();

  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");
  await expect(holdingRow(page, "Acción unificada")).toBeVisible();
});

test("debt: credit_card → Deuda añadida", async ({ page }) => {
  await pickInstrument(page, "credit_card");

  await page.locator('input[name="name_credit_card"]').fill("Tarjeta unificada");
  await page.locator('input[name="balance_credit_card"]').fill("850");

  await page.getByRole("button", { name: "Añadir al patrimonio" }).click();

  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Deuda añadida.");
  await expect(holdingRow(page, "Tarjeta unificada")).toBeVisible();
});
