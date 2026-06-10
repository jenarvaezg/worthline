/**
 * Journey 5: New investment → record buy operation → P/L renders
 *            Typed input survives a validation error (units field left empty).
 *
 * Uses MANUAL price (no ticker) to avoid any network calls to stooq.
 */

import { test, expect } from "./fixtures";

test("investment: create with manual price → buy operation → P/L visible", async ({
  page,
}) => {
  // 1. Navigate to nueva inversión
  await page.goto("/inversiones/nueva");
  await expect(page.getByRole("heading", { name: "Nueva inversión" })).toBeVisible();

  // 2. Fill the form — MANUAL price, no ticker/provider symbol
  await page.getByLabel("Nombre de la inversión").fill("Fondo Test E2E");
  // Leave ticker empty (no network call)
  await page.getByLabel("Precio actual por unidad en EUR").fill("100");

  // 3. Submit
  await page.getByRole("button", { name: "Añadir inversión" }).click();

  // 4. The success banner appears. The action redirects back to currentUrl which
  //    is /inversiones/nueva (the form's hidden input), so we're still on that
  //    page with the ok banner. Navigate explicitly to the investments list.
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");
  await page.goto("/inversiones");

  // 5. The new investment row appears in the list
  await expect(page.getByRole("cell", { name: "Fondo Test E2E" })).toBeVisible();

  // 6. Find the asset row and click "Operar"
  const investmentRow = page.getByRole("row", { name: /Fondo Test E2E/ });
  await investmentRow.getByRole("link", { name: "Operar" }).click();

  // 7. On the operation page
  await expect(
    page.getByRole("heading", { name: "Registrar operación" }),
  ).toBeVisible();

  // 8. Trigger a validation error: submit with units left empty
  const unitsInput = page.getByLabel("Unidades");
  const priceInput = page.getByLabel("Precio por unidad en EUR");
  await priceInput.fill("105,50");
  await unitsInput.clear();
  await page.getByRole("button", { name: "Registrar operación" }).click();

  // 9. Error banner shown — typed price value is preserved
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(priceInput).toHaveValue("105,50");

  // 10. Now fill units correctly and submit
  await unitsInput.fill("10");
  await page.getByRole("button", { name: "Registrar operación" }).click();

  // 11. Success redirect — back on the operacion page with ok banner
  await expect(page.getByRole("status")).toBeVisible();

  // 12. Navigate to /inversiones — P/L column should now render a value
  await page.goto("/inversiones");
  const plCell = page
    .getByRole("row", { name: /Fondo Test E2E/ })
    .locator("td")
    .nth(5); // P/L column index
  const plText = await plCell.textContent();
  // With 10 units at cost 105.50 and manual price 100, there should be a P/L figure
  expect(plText).toBeTruthy();
  // P/L is either a formatted amount or "—"; after a buy at 105.50 vs price 100
  // we expect a loss figure (not "—") since price < cost
  expect(plText).not.toBe("—");
});
