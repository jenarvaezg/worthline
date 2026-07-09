/**
 * Journey 38: the add wizard's success loop (PRD #593 S5, #600).
 *
 * After a simple-drawer alta the wizard returns to a success screen instead of
 * the holdings list: it shows the running net worth and chains adds —
 * «Añadir otra» restarts the loop, «Ver mi patrimonio» exits. Runs late so the
 * holdings it adds don't perturb earlier totals (and so the wizard shows the
 * normal copy, not the first-run welcome).
 */

import { expect, holdingRow, test } from "./fixtures";

async function addCash(
  page: import("@playwright/test").Page,
  name: string,
  value: string,
) {
  await page.locator('label.simpleDrawerCard:has(input[value="dinero"])').click();
  const pane = page.locator('.simpleDrawerPane[data-drawer="dinero"]');
  await pane.locator('input[name="simpleName_dinero"]').fill(name);
  await pane.locator('input[name="simpleValue_dinero"]').fill(value);
  await pane.getByRole("button", { name: "Añadir" }).click();
}

test("success loop: a simple add lands on the success screen and chains another", async ({
  page,
}) => {
  // 1. Add cash through the simple wizard.
  await page.goto("/patrimonio/anadir");
  await addCash(page, "Cuenta loop uno", "1.000,00");

  // 2. The success screen (loop), not the holdings list — with the running total.
  await expect(page).toHaveURL(/\/patrimonio\/anadir\?ok=asset_added/);
  await expect(page.getByRole("heading", { name: /Activo añadido/ })).toBeVisible();
  await expect(page.locator(".addSuccessTotal")).toContainText("Patrimonio neto");

  // 3. «Añadir otra» restarts the loop — the drawer form is back.
  await page.getByRole("link", { name: /Añadir otra/ }).click();
  await expect(page).toHaveURL(/\/patrimonio\/anadir(\?|$)/);
  await expect(
    page.getByRole("heading", { name: "Añade algo a tu patrimonio" }),
  ).toBeVisible();

  // 4. A second add, then exit via «Ver mi patrimonio».
  await addCash(page, "Cuenta loop dos", "500,00");
  await expect(page.getByRole("heading", { name: /Activo añadido/ })).toBeVisible();

  await page.getByRole("link", { name: /Ver mi patrimonio/ }).click();
  await expect(page).toHaveURL(/\/patrimonio(\?|$)/);
  await expect(holdingRow(page, "Cuenta loop uno")).toBeVisible();
  await expect(holdingRow(page, "Cuenta loop dos")).toBeVisible();
});
