/**
 * Journey 15: Vaciar papelera (issue #84)
 *
 * Soft-deletes two assets into the Papelera, then empties the whole trash in
 * one action and verifies both are gone.
 */

import { test, expect, addHolding, deleteHolding } from "./fixtures";

async function createAndTrash(page: import("@playwright/test").Page, name: string) {
  await addHolding(page, {
    instrument: "current_account",
    name: name,
    value: "100",
  });
  await expect(page).toHaveURL(/\/patrimonio/);

  await deleteHolding(page, name);
  await expect(page.getByRole("status")).toContainText("Papelera");
}

test("vaciar papelera removes every trashed holding at once", async ({ page }) => {
  await createAndTrash(page, "Vaciar Uno");
  await createAndTrash(page, "Vaciar Dos");

  // Open the Papelera (its own summary) — both items present
  await page.locator("details.balanceTrash > summary").click();
  await expect(page.locator(".balanceTrashRow", { hasText: "Vaciar Uno" })).toBeVisible();
  await expect(page.locator(".balanceTrashRow", { hasText: "Vaciar Dos" })).toBeVisible();

  // Empty the whole trash (two-step confirm)
  const emptyAll = page.locator("form.balanceTrashEmptyAll details.confirmDelete");
  await emptyAll.locator("summary").click();
  await emptyAll.getByRole("button", { name: "Confirmar vaciado de papelera" }).click();

  // Success banner and an empty trash — assert on the DOM count and the panel
  // label so the check does not depend on the (collapsed) panel being reopened.
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toContainText("vaciada");
  await expect(page.locator(".balanceTrashRow")).toHaveCount(0);
  await expect(page.locator("details.balanceTrash > summary")).toHaveText(
    /Papelera \(0\)/,
  );
});
