/**
 * Journey 10: Ownership split validation
 *
 * Verifies that the server-side resolveOwnershipSplit() preserves explicit
 * custom percentages and the even-split preset. Both journeys require at
 * least 2 active members (from journey 2).
 *
 * 1. Custom split: fill 60/40 on a property (only instrument that allows
 *    custom ownership below 100%, #737) via real Playwright interactions,
 *    submit, verify the asset appears in the minority owner's scope.
 * 2. Even-split preset: select "Repartir a partes iguales", submit,
 *    verify the asset is visible in both member scopes.
 */

import { test, expect } from "./fixtures";

test("ownership: custom 60/40 split via real interactions, visible in minority scope", async ({
  page,
}) => {
  await page.goto("/patrimonio/anadir/avanzado?instrument=property");
  await expect(page.getByRole("heading", { name: /Añadir holding/ })).toBeVisible();

  const ownershipFieldset = page.getByRole("group", { name: "Propiedad" });
  await expect(ownershipFieldset).toBeVisible();

  await page.locator('input[name="name_property"]').fill("Activo Split Test");
  await page.locator('input[name="acqDate_property"]').fill("2020-01-15");
  await page.locator('input[name="acqValue_property"]').fill("500000");

  await ownershipFieldset.getByRole("radio", { name: /Personalizado/ }).check();

  // Collect member scope buttons to identify the minority owner
  const scopeNav = page.locator("[aria-label='Selector de ámbito']");
  const scopeButtons = scopeNav.getByRole("button");
  const scopeCount = await scopeButtons.count();
  expect(scopeCount).toBeGreaterThanOrEqual(2);

  // Get the second member's name from the scope button text
  const secondMemberName = await scopeButtons.nth(1).textContent();
  expect(secondMemberName).toBeTruthy();

  // Fill custom percentages: first member gets 60%, second (minority) gets 40%
  const firstInput = ownershipFieldset.locator("input[name^='owner_']").first();
  const secondInput = ownershipFieldset.locator("input[name^='owner_']").nth(1);
  await firstInput.fill("60");
  await secondInput.fill("40");

  // Submit — the custom split totals 100%, so this must succeed
  await page.getByRole("button", { name: "Añadir al patrimonio" }).click();
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  const assetId = new URL(page.url()).hash.slice(1);
  expect(assetId).toBeTruthy();

  // Asset row is visible in default scope
  await expect(page.locator(`#${assetId}`)).toBeVisible();

  // Switch to the second (minority) member's scope — asset must be visible
  // because both members have explicit ownership allocated.
  await scopeButtons.nth(1).click();
  await page.waitForURL(/\/patrimonio/);
  await expect(page.locator(`#${assetId}`)).toBeVisible();
});

test("ownership: even-split preset makes asset visible in both member scopes", async ({
  page,
}) => {
  await page.goto("/patrimonio/anadir/avanzado");
  await expect(page.getByRole("heading", { name: /Añadir holding/ })).toBeVisible();
  await page.locator(`label.addHoldingChip:has(input[value="current_account"])`).click();

  const ownershipFieldset = page.getByRole("group", { name: "Propiedad" });
  await expect(ownershipFieldset).toBeVisible();

  await page.locator('input[name="name_current_account"]').fill("Activo Even Split");
  await page.locator('input[name="value_current_account"]').fill("10000");

  // Select the "Repartir a partes iguales" preset
  await ownershipFieldset.getByRole("radio", { name: /partes iguales/i }).click();

  // Submit
  await page.getByRole("button", { name: "Añadir al patrimonio" }).click();
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  const assetId = new URL(page.url()).hash.slice(1);
  expect(assetId).toBeTruthy();

  // Asset visible in default (Hogar) scope
  await expect(page.locator(`#${assetId}`)).toBeVisible();

  // Switch to first individual member's scope — asset must be visible
  const scopeNav = page.locator("[aria-label='Selector de ámbito']");
  const scopeButtons = scopeNav.getByRole("button");
  const scopeCount = await scopeButtons.count();
  expect(scopeCount).toBeGreaterThanOrEqual(2);

  await scopeButtons.nth(1).click();
  await page.waitForURL(/\/patrimonio/);
  await expect(page.locator(`#${assetId}`)).toBeVisible();

  // Switch to second individual member's scope — asset must also be visible
  await scopeButtons.nth(2).click();
  await page.waitForURL(/\/patrimonio/);
  await expect(page.locator(`#${assetId}`)).toBeVisible();
});
