/**
 * Journey 3: Create asset → success lands at /patrimonio#<id> with success message
 */

import { test, expect, addHolding } from "./fixtures";

test("create asset: form → success banner → anchored row in /patrimonio", async ({
  page,
}) => {
  await addHolding(page, {
    instrument: "current_account",
    name: "Cuenta ING",
    value: "5000",
  });

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
