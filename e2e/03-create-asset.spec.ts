/**
 * Journey 3: Create asset → success lands at /patrimonio#<id> with success message
 */

import { test, expect } from "@playwright/test";

test("create asset: form → success banner → anchored row in /patrimonio", async ({
  page,
}) => {
  await page.goto("/patrimonio/nuevo-activo");
  await expect(page.getByRole("heading", { name: "Nuevo activo" })).toBeVisible();

  // Fill the form
  await page.getByLabel("Nombre del activo").fill("Cuenta ING");
  // Type stays as "cash" (default), liquidityTier stays "cash" (default)
  await page.getByLabel("Valor actual en EUR").fill("5000");

  // Submit
  await page.getByRole("button", { name: "Añadir activo" }).click();

  // Should land on /patrimonio with success banner
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // The asset row must exist in the table
  await expect(page.getByRole("cell", { name: "Cuenta ING" })).toBeVisible();

  // URL should contain an anchor fragment pointing to the new asset row
  const url = page.url();
  expect(url).toMatch(/#.+/);

  // The row element pointed to by the anchor must be in the DOM
  const anchor = new URL(url).hash.slice(1); // remove '#'
  expect(anchor).toBeTruthy();
  await expect(page.locator(`#${anchor}`)).toBeVisible();
});
