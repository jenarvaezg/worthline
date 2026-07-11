/**
 * Journey 8: Warning lifecycle
 *
 * Create a zero-value asset → warning band links to the asset row →
 * "Es intencional" button at the row overrides → override appears in /ajustes
 * and is retractable.
 */

import { addHolding, expect, openHoldingMenu, test } from "./fixtures";

test("warning lifecycle: zero asset → warning badge → override → listed in ajustes → retractable", async ({
  page,
}) => {
  // 1. Create a zero-value asset (triggers ZERO_VALUE_ASSET warning)
  await addHolding(page, {
    instrument: "current_account",
    name: "Activo Cero",
    value: "0",
  });
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // Extract the new asset's ID from the URL hash (e.g. /patrimonio?ok=asset_added#asset_activo_cero_...)
  const createdUrl = page.url();
  const assetId = new URL(createdUrl).hash.slice(1); // strip '#'
  expect(assetId).toBeTruthy();

  // 2. The asset row must exist in the DOM and carry a warningBadge
  const assetRow = page.locator(`#${assetId}`);
  await expect(assetRow).toBeVisible();
  await expect(assetRow.locator(".warningBadge")).toBeVisible();

  // 3. The global shell warning band was retired (#665, PRD #654 S3): it must no
  //    longer appear on the home. The zero-value holding still surfaces as a board
  //    badge (step 2 above) and, when it is the top signal, in the hero's
  //    data-health alert — attention lives in one place, not a rail on every page.
  await page.goto("/");
  await expect(page.getByRole("alert", { name: "Avisos" })).toHaveCount(0);

  // 4. Back on /patrimonio, open the row's ⋯ menu and find the "Es intencional"
  //    button inside the specific row (#271 moved the action into the popover).
  await page.goto("/patrimonio");
  await openHoldingMenu(page, "Activo Cero");
  const targetRow = page.locator(`#${assetId}`);
  const esIntencionalBtn = targetRow.getByRole("button", { name: "Es intencional" });
  await expect(esIntencionalBtn).toBeVisible();

  // 5. Count overrides before acknowledging
  await page.goto("/ajustes");
  const beforeCount = await page.locator(".overrideRow").count();

  // 6. Acknowledge the warning on that specific row (open its ⋯ menu first).
  await page.goto("/patrimonio");
  await openHoldingMenu(page, "Activo Cero");
  await page
    .locator(`#${assetId}`)
    .getByRole("button", { name: "Es intencional" })
    .click();
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toBeVisible();

  // 7. The override appears in /ajustes — count increased by 1
  await page.goto("/ajustes");
  await expect(page.getByRole("region", { name: "Overrides de avisos" })).toBeVisible();
  const afterCount = await page.locator(".overrideRow").count();
  expect(afterCount).toBe(beforeCount + 1);

  // 8. Find and retract the newly added override (it's for our asset ID).
  //    The confirmDelete <details> must be open for the button to be clickable.
  //    Use filter to pin to the exact override row containing our entity id.
  const ourOverride = page.locator(".overrideRow").filter({ hasText: assetId });
  await expect(ourOverride).toBeVisible();
  // Force-open the <details> via JS so the submit button is reachable
  await ourOverride
    .locator("details.confirmDelete")
    .evaluate((el: HTMLDetailsElement) => {
      el.open = true;
    });
  // Wait until the button is visible (details is open)
  const confirmBtn = ourOverride.locator("details.confirmDelete button[type='submit']");
  await expect(confirmBtn).toBeVisible();
  // Click and wait for the navigation that the server action triggers
  await Promise.all([page.waitForURL(/\/ajustes\?ok=saved/), confirmBtn.click()]);

  // 9. Verify we landed on the success URL
  await expect(page).toHaveURL(/\/ajustes\?ok=saved/);
  const finalCount = await page.locator(".overrideRow").count();
  expect(finalCount).toBe(beforeCount);
});
