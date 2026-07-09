/**
 * Journey 9: Delete → papelera → restore round-trip
 *
 * Creates a fresh asset, soft-deletes it (two-step confirm), verifies it
 * appears in the Papelera, then restores it and verifies it's back in the
 * active assets table.
 */

import {
  addHolding,
  delayServerActions,
  expect,
  holdingRow,
  openHoldingMenu,
  test,
} from "./fixtures";

test("delete → papelera → restore round-trip", async ({ page }) => {
  // 1. Create a dedicated asset for this test
  await addHolding(page, {
    instrument: "current_account",
    name: "Activo Para Borrar",
    value: "1234",
  });
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // 2. The asset row is visible in the active listing
  await expect(holdingRow(page, "Activo Para Borrar")).toBeVisible();

  // 3. Soft-delete via the row's ⋯ menu → nested two-step confirm. The delete is
  //    OPTIMISTIC (#521, interaction-patterns §4): with the Server Action delayed,
  //    the row must vanish the instant we confirm — before the action resolves and
  //    without a document reload (a window sentinel that a full reload would wipe).
  await page.evaluate(() => {
    (window as Window & { __wlNoReload?: boolean }).__wlNoReload = true;
  });
  const release = await delayServerActions(page, 2000);

  await openHoldingMenu(page, "Activo Para Borrar");
  const del = holdingRow(page, "Activo Para Borrar").locator("details.confirmDelete");
  await del.locator("summary").click();
  await del.getByRole("button", { name: "Confirmar" }).click();

  // Optimistic: gone from the listing immediately. The Server Action is held for
  // 2s, so the row could only have vanished client-side — before the delete is
  // processed — and the sentinel proves no document reload happened.
  await expect(holdingRow(page, "Activo Para Borrar")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __wlNoReload?: boolean }).__wlNoReload,
    ),
  ).toBe(true);

  await release();

  // 4. Once the action resolves it redirects to /patrimonio with the
  //    "deleted_recoverable" success message — settling the optimistic change.
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("Papelera");

  // 5. Asset no longer in the active listing
  await expect(holdingRow(page, "Activo Para Borrar")).toHaveCount(0);

  // 6. Open the Papelera section (its own summary — the trash now also nests
  //    per-row "Eliminar definitivamente" and a "Vaciar papelera" summary).
  const trashPanel = page.locator("details.balanceTrash");
  await trashPanel.locator("> summary").click();
  await expect(page.getByText("Activo Para Borrar")).toBeVisible();

  // 7. Restore the asset
  const trashRow = page.locator(".balanceTrashRow", { hasText: "Activo Para Borrar" });
  await trashRow.getByRole("button", { name: "Restaurar" }).click();

  // 8. Back on /patrimonio with success message
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("Restaurado");

  // 9. Asset is back in the active listing
  await expect(holdingRow(page, "Activo Para Borrar")).toBeVisible();
});
