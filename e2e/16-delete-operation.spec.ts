/**
 * Journey 16: Delete an investment operation (issue #81)
 *
 * Creates an investment with a manual price (no network), records a buy
 * operation, then deletes that operation from the investment detail and
 * verifies the recent-operations list no longer shows it.
 */

import { test, expect } from "./fixtures";

test("record an operation, then delete it", async ({ page }) => {
  // 1. New investment with a manual price (no ticker → no network)
  await page.goto("/inversiones/nueva");
  await page.getByLabel("Nombre de la inversión").fill("Inv Op Borrado");
  await page.getByLabel("Precio actual por unidad en EUR").fill("50");
  await page.getByRole("button", { name: "Añadir inversión" }).click();
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // 2. Go to its operation page and record a buy
  await page.goto("/inversiones");
  await page
    .getByRole("row", { name: /Inv Op Borrado/ })
    .getByRole("link", { name: "Operar" })
    .click();
  await expect(page.getByRole("heading", { name: "Registrar operación" })).toBeVisible();

  await page.getByLabel("Unidades").fill("10");
  await page.getByLabel("Precio por unidad en EUR").fill("50");
  await page.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page.getByRole("status")).toBeVisible();

  // 3. The recent-operations panel lists exactly one row
  const opsPanel = page.locator("details.recentOpsPanel");
  await expect(opsPanel).toBeVisible();
  await expect(opsPanel.locator("tbody tr")).toHaveCount(1);

  // 4. Delete that operation (two-step confirm)
  const opDelete = opsPanel.locator("tbody tr").first().locator("details.confirmDelete");
  await opDelete.locator("summary").click();
  await opDelete.getByRole("button", { name: "Confirmar" }).click();

  // 5. Success banner and the operation is gone (panel no longer rendered)
  await expect(page.getByRole("status")).toContainText("Operación eliminada");
  await expect(page.locator("details.recentOpsPanel")).toHaveCount(0);
});
