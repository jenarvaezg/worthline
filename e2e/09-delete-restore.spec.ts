/**
 * Journey 9: Delete → papelera → restore round-trip
 *
 * Creates a fresh asset, soft-deletes it (two-step confirm), verifies it
 * appears in the Papelera, then restores it and verifies it's back in the
 * active assets table.
 */

import { test, expect, addHolding } from "./fixtures";

test("delete → papelera → restore round-trip", async ({ page }) => {
  // 1. Create a dedicated asset for this test
  await addHolding(page, {
    instrument: "current_account",
    name: "Activo Para Borrar",
    value: "1234",
  });
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // 2. The asset row is visible in the active table
  await expect(page.getByRole("cell", { name: "Activo Para Borrar" })).toBeVisible();

  // 3. Find the row and trigger the two-step delete
  const assetRow = page.getByRole("row", { name: /Activo Para Borrar/ });
  const deleteDetails = assetRow.locator("details.confirmDelete");
  // Open the confirm panel
  await deleteDetails.locator("summary").click();
  // Confirm deletion
  await deleteDetails.getByRole("button", { name: "Confirmar" }).click();

  // 4. Redirected to /patrimonio with "deleted_recoverable" success message
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("Papelera");

  // 5. Asset no longer in the active table
  await expect(page.getByRole("cell", { name: "Activo Para Borrar" })).not.toBeVisible();

  // 6. Open the Papelera section (its own summary — the trash now also nests
  //    per-row "Eliminar definitivamente" and a "Vaciar papelera" summary).
  const trashPanel = page.locator("details.trashPanel");
  await trashPanel.locator("> summary").click();
  await expect(page.getByText("Activo Para Borrar")).toBeVisible();

  // 7. Restore the asset
  const trashRow = page.locator(".trashRow", { hasText: "Activo Para Borrar" });
  await trashRow.getByRole("button", { name: "Restaurar" }).click();

  // 8. Back on /patrimonio with success message
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("Restaurado");

  // 9. Asset is back in the active table
  await expect(page.getByRole("cell", { name: "Activo Para Borrar" })).toBeVisible();
});
