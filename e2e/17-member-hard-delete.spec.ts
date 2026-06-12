/**
 * Journey 17: Hard delete a member (issue #82)
 *
 * A member is destroyable only once disabled and owning no share of any
 * holding. This journey creates a throwaway member (no ownerships), disables
 * it, and hard-deletes it from the Miembros section of /ajustes.
 */

import { test, expect } from "./fixtures";

const NAME = "Miembro Temporal E2E";

test("disable then hard-delete a member with no holdings", async ({ page }) => {
  await page.goto("/ajustes");

  // 1. Add a throwaway member
  await page.getByLabel("Nuevo miembro").fill(NAME);
  await page.getByRole("button", { name: "Añadir" }).click();
  await expect(page).toHaveURL(/\/ajustes/);

  // The member's name lives in an <input value="…">, not in text content, so
  // locate its row by that input rather than by text.
  const rowByName = () =>
    page.locator(".memberRow").filter({ has: page.locator(`input[value="${NAME}"]`) });

  const row = rowByName();
  await expect(row).toBeVisible();

  // 2. While active there is no hard-delete affordance
  await expect(row.getByText("Eliminar definitivamente")).toHaveCount(0);

  // 3. Disable it (two-step confirm)
  await row.getByText("Desactivar", { exact: true }).click();
  await row.getByRole("button", { name: "Confirmar desactivación" }).click();
  await expect(page).toHaveURL(/\/ajustes/);

  // 4. Now hard-delete it (two-step confirm)
  const disabledRow = rowByName();
  await disabledRow.getByText("Eliminar definitivamente").click();
  await disabledRow.getByRole("button", { name: "Confirmar borrado definitivo" }).click();

  // 5. Success banner and the member is gone
  await expect(page.getByRole("status")).toContainText("borrado");
  await expect(rowByName()).toHaveCount(0);
});
