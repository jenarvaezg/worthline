/**
 * Journey 16: Delete an investment operation (issue #81).
 *
 * Creates an investment with a manual price (no network), records a buy
 * operation, then deletes that operation and verifies the recent-operations
 * panel no longer shows it.
 *
 * #153 collapsed the /inversiones management section: add happens on the kept
 * /patrimonio/anadir route, and operations (record + delete) are managed on the
 * holding's own ficha (/patrimonio/[id]/editar).
 */

import { test, expect, addHolding, holdingRow } from "./fixtures";

test("record an operation, then delete it", async ({ page }) => {
  // 1. New investment with a manual price (no ticker → no network).
  await addHolding(page, {
    instrument: "fund",
    name: "Inv Op Borrado",
    price: "50",
  });
  await expect(page.getByRole("status")).toHaveText("Inversión añadida.");

  // 2. Open the investment's ficha from the unified Patrimonio list.
  await page.goto("/patrimonio");
  await holdingRow(page, "Inv Op Borrado")
    .getByRole("link", { name: "Inv Op Borrado" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await expect(
    page.getByRole("region", { name: "Operaciones de la inversión" }),
  ).toBeVisible();

  // 3. Record a buy from the ficha's operations editor.
  const opForm = page.getByRole("form", { name: "Registrar operación" });
  await opForm.getByLabel("Unidades").fill("10");
  await opForm.getByLabel("Precio por unidad en EUR").fill("50");
  await page.getByRole("button", { name: "Registrar operación" }).click();
  await expect(page).toHaveURL(/ok=saved/);
  await expect(page.getByRole("status")).toBeVisible();

  // 4. The recent-operations panel lists exactly one row.
  const opsPanel = page.locator("details.recentOpsPanel");
  await expect(opsPanel).toBeVisible();
  await expect(opsPanel.locator("tbody tr")).toHaveCount(1);

  // 5. Delete that operation (two-step confirm).
  const opDelete = opsPanel.locator("tbody tr").first().locator("details.confirmDelete");
  await opDelete.locator("summary").click();
  await opDelete.getByRole("button", { name: "Confirmar" }).click();

  // 6. Success banner and the operation is gone (panel no longer rendered).
  await expect(page.getByRole("status")).toContainText("Operación eliminada");
  await expect(page.locator("details.recentOpsPanel")).toHaveCount(0);
});
