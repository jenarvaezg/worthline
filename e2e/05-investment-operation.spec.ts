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
  await expect(page.getByRole("heading", { name: "Registrar operación" })).toBeVisible();

  // 8. Trigger a validation error: submit with units left empty. The server
  //    rejects the empty units field and redirects back to the operacion page
  //    with `error=` + the preserved typed values (intake.errorRedirectUrl).
  const operationForm = page.locator("form.inversionesForm");
  await operationForm.getByLabel("Precio por unidad en EUR").fill("105,50");
  await operationForm.getByLabel("Unidades").clear();
  await operationForm.getByRole("button", { name: "Registrar operación" }).click();

  // 9. Wait for the error navigation to FULLY settle before touching the form
  //    again: assert the URL carries the error param (the server-action
  //    redirect landed) and the error banner is shown. Without this wait the
  //    next fill can land on the pre-navigation form node and be discarded by
  //    the RSC swap — the root cause of this journey's historical flakiness.
  //    Scope to the page's own error band: Next.js mounts a `role="alert"`
  //    route announcer during client navigation, so a bare getByRole("alert")
  //    is ambiguous in strict mode.
  await expect(page).toHaveURL(/error=/);
  const errorBand = page.locator("#operation-error");
  await expect(errorBand).toBeVisible();
  await expect(errorBand).toHaveText("Las unidades son obligatorias.");
  // The typed price survives the round-trip (units was empty, so it does not).
  await expect(operationForm.getByLabel("Precio por unidad en EUR")).toHaveValue(
    "105,50",
  );

  // 10. Re-fill both fields on the settled form and confirm the DOM values
  //     stuck before submitting (assert the values rather than polling
  //     FormData — a deterministic, non-racy check against the live inputs).
  await operationForm.getByLabel("Unidades").fill("10");
  await operationForm.getByLabel("Precio por unidad en EUR").fill("105,50");
  await expect(operationForm.getByLabel("Unidades")).toHaveValue("10");
  await expect(operationForm.getByLabel("Precio por unidad en EUR")).toHaveValue(
    "105,50",
  );
  await operationForm.getByRole("button", { name: "Registrar operación" }).click();

  // 11. Success redirect — the action lands back on the operacion page with
  //     `ok=saved`. Wait for that URL transition first (the deterministic
  //     signal the operation persisted), then assert the status banner.
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("status")).toHaveText("Guardado.");

  // 12. Navigate to /inversiones — P/L column should now render a value
  // (the locator from step 6 is lazy, so it re-resolves on the fresh page)
  await page.goto("/inversiones");
  await expect(investmentRow).toBeVisible();

  // Locate P/L semantically: the column header is "P/L" (6th column).
  const plCell = investmentRow.locator("td").nth(5);
  const plText = await plCell.textContent();

  // 10 units bought at 105,50 EUR with current price 100 EUR → P/L = -55,00 €.
  // formatMoneyMinor renders es-ES currency with no cents: expect "55" and "€".
  expect(plText).toBeTruthy();
  expect(plText).not.toBe("—");
  expect(plText).toMatch(/55/);
  expect(plText).toContain("€");
});
