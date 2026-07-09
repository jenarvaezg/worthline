/**
 * Journey 14: Trash → hard delete (issue #80)
 *
 * Creates an asset, soft-deletes it into the Papelera, then destroys it
 * permanently from the trash and verifies it is gone for good (no longer
 * restorable). The trash is the only doorway to a hard delete.
 */

import { addHolding, deleteHolding, expect, holdingRow, test } from "./fixtures";

test("trash → eliminar definitivamente → gone for good", async ({ page }) => {
  // 1. Create a dedicated asset
  await addHolding(page, {
    instrument: "current_account",
    name: "Activo Borrado Duro",
    value: "999",
  });
  await expect(page).toHaveURL(/\/patrimonio/);

  // 2. Soft-delete it into the Papelera (⋯ menu → nested two-step confirm).
  await deleteHolding(page, "Activo Borrado Duro");
  await expect(page.getByRole("status")).toContainText("Papelera");

  // 3. Open the Papelera and hard-delete the item
  const trashPanel = page.locator("details.balanceTrash");
  await trashPanel.locator("summary").first().click();
  const trashRow = page.locator(".balanceTrashRow", { hasText: "Activo Borrado Duro" });
  const hardDelete = trashRow.locator("details.confirmDelete");
  await hardDelete.locator("summary").click();
  await hardDelete.getByRole("button", { name: "Confirmar borrado definitivo" }).click();

  // 4. Success banner and the item is gone from the trash entirely
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("definitivamente");

  await page.locator("details.balanceTrash").locator("summary").first().click();
  await expect(
    page.locator(".balanceTrashRow", { hasText: "Activo Borrado Duro" }),
  ).toHaveCount(0);

  // 5. And it is not in the active listing either
  await expect(holdingRow(page, "Activo Borrado Duro")).toHaveCount(0);
});
