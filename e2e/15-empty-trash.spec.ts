/**
 * Journey 15: Vaciar papelera (issue #84)
 *
 * Soft-deletes two assets into the Papelera, then empties the whole trash in
 * one action and verifies both are gone.
 */

import { test, expect, addHolding } from "./fixtures";

async function createAndTrash(page: import("@playwright/test").Page, name: string) {
  await addHolding(page, {
    instrument: "current_account",
    name: name,
    value: "100",
  });
  await expect(page).toHaveURL(/\/patrimonio/);

  const row = page.getByRole("row", { name: new RegExp(name) });
  const del = row.locator("details.confirmDelete");
  await del.locator("summary").click();
  await del.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByRole("status")).toContainText("Papelera");
}

test("vaciar papelera removes every trashed holding at once", async ({ page }) => {
  await createAndTrash(page, "Vaciar Uno");
  await createAndTrash(page, "Vaciar Dos");

  // Open the Papelera (its own summary) — both items present
  await page.locator("details.trashPanel > summary").click();
  await expect(page.locator(".trashRow", { hasText: "Vaciar Uno" })).toBeVisible();
  await expect(page.locator(".trashRow", { hasText: "Vaciar Dos" })).toBeVisible();

  // Empty the whole trash (two-step confirm)
  const emptyAll = page.locator("form.trashEmptyAll details.confirmDelete");
  await emptyAll.locator("summary").click();
  await emptyAll.getByRole("button", { name: "Confirmar vaciado de papelera" }).click();

  // Success banner and an empty trash — assert on the DOM count and the panel
  // label so the check does not depend on the (collapsed) panel being reopened.
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("vaciada");
  await expect(page.locator(".trashRow")).toHaveCount(0);
  await expect(page.locator("details.trashPanel > summary")).toHaveText(/Papelera \(0\)/);
});
