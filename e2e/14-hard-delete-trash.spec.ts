/**
 * Journey 14: Trash → hard delete (issue #80)
 *
 * Creates an asset, soft-deletes it into the Papelera, then destroys it
 * permanently from the trash and verifies it is gone for good (no longer
 * restorable). The trash is the only doorway to a hard delete.
 */

import { test, expect } from "./fixtures";

test("trash → eliminar definitivamente → gone for good", async ({ page }) => {
  // 1. Create a dedicated asset
  await page.goto("/patrimonio/nuevo-activo");
  await page.getByLabel("Nombre del activo").fill("Activo Borrado Duro");
  await page.getByLabel("Valor actual en EUR").fill("999");
  await page.getByRole("button", { name: "Añadir activo" }).click();
  await expect(page).toHaveURL(/\/patrimonio/);

  // 2. Soft-delete it into the Papelera (two-step confirm in its row)
  const assetRow = page.getByRole("row", { name: /Activo Borrado Duro/ });
  const deleteDetails = assetRow.locator("details.confirmDelete");
  await deleteDetails.locator("summary").click();
  await deleteDetails.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toContainText("Papelera");

  // 3. Open the Papelera and hard-delete the item
  const trashPanel = page.locator("details.trashPanel");
  await trashPanel.locator("summary").first().click();
  const trashRow = page.locator(".trashRow", { hasText: "Activo Borrado Duro" });
  const hardDelete = trashRow.locator("details.confirmDelete");
  await hardDelete.locator("summary").click();
  await hardDelete.getByRole("button", { name: "Confirmar borrado definitivo" }).click();

  // 4. Success banner and the item is gone from the trash entirely
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("definitivamente");

  await page.locator("details.trashPanel").locator("summary").first().click();
  await expect(page.locator(".trashRow", { hasText: "Activo Borrado Duro" })).toHaveCount(
    0,
  );

  // 5. And it is not in the active table either
  await expect(page.getByRole("cell", { name: "Activo Borrado Duro" })).not.toBeVisible();
});
