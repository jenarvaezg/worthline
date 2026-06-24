/**
 * Journey 4: Puesta al día — edit two values in one form → both persist → headline moves
 *
 * Relies on at least one manual asset existing (created in journey 3).
 * Adds a second asset here so there are two values to update in one batch.
 */

import { test, expect, addHolding, delayServerActions } from "./fixtures";

function parseEuroMinor(text: string | null): number {
  expect(text).toBeTruthy();

  const normalized = text!
    .replace(/\u00a0/g, " ")
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const value = Number(normalized);

  expect(Number.isFinite(value)).toBe(true);

  return Math.round(value * 100);
}

test("puesta al dia: batch update two assets → values persist → headline changes", async ({
  page,
}) => {
  // 1. Create a second manual asset so we have two to update
  await addHolding(page, {
    instrument: "current_account",
    name: "Fondo Monetario",
    value: "3000",
  });
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // 2. Note the headline before update
  //    (500€ seed + 5000€ test 03 + 3000€ just created = 8500€)
  await page.goto("/");
  const headlineBeforeMinor = parseEuroMinor(
    await page
      .getByRole("region", { name: "Resumen patrimonial" })
      .locator(".headline strong")
      .textContent(),
  );
  expect(headlineBeforeMinor).toBe(8500_00);

  // 3. Open the "Puesta al día" form
  await page.goto("/patrimonio/actualizar");
  await expect(page.getByRole("heading", { name: "Puesta al día" })).toBeVisible();

  // 4. Fill in new values for both assets
  await page.getByLabel("Valor de Cuenta ING en EUR").fill("8000");
  await page.getByLabel("Valor de Fondo Monetario en EUR").fill("4000");

  // 5. Submit the form. The pass is OPTIMISTIC (#521, interaction-patterns §4):
  //    with the Server Action delayed, each row's "Actual:" must show its just-typed
  //    value BEFORE the action resolves — and without a document reload (a window
  //    sentinel a full reload would wipe).
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });
  const release = await delayServerActions(page, 2000);

  await page.getByRole("button", { name: "Guardar todo" }).click();

  // Optimistic: Cuenta ING's "Actual:" reflects the new 8000 while the action is
  // still in-flight (still on /actualizar) and no reload has happened.
  const cuentaIngActual = page
    .locator(".puestaRow", { has: page.getByLabel("Valor de Cuenta ING en EUR") })
    .locator(".puestaCurrent");
  await expect(cuentaIngActual).toContainText("8000");
  await expect(page).toHaveURL(/\/patrimonio\/actualizar/);
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);

  await release();

  // 6. Once the action resolves it redirects back to /patrimonio with the success
  //    message — settling the optimistic values.
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("Valores actualizados");

  // 7. Back on /, headline should show the exact updated net worth
  //    (500€ seed + 8000€ + 4000€ = 12500€)
  await page.goto("/");
  const headlineAfterMinor = parseEuroMinor(
    await page
      .getByRole("region", { name: "Resumen patrimonial" })
      .locator(".headline strong")
      .textContent(),
  );
  expect(headlineAfterMinor).toBe(12500_00);
  expect(headlineAfterMinor).toBeGreaterThan(headlineBeforeMinor);

  // 8. Verify changes persist after a full reload of the form
  await page.goto("/patrimonio/actualizar");
  await page.reload();
  await expect(page.getByLabel("Valor de Cuenta ING en EUR")).toHaveValue("8000,00");
  await expect(page.getByLabel("Valor de Fondo Monetario en EUR")).toHaveValue("4000,00");

  // 9. Liquidity section renders the tier donut with at least one segment
  await page.goto("/");
  const liquidityRegion = page.getByRole("region", { name: "Liquidez por capa" });
  await expect(liquidityRegion.locator(".tierDonut")).toBeVisible();
  expect(
    await liquidityRegion.locator(".tierDonut .donutSegment").count(),
  ).toBeGreaterThanOrEqual(1);
});
