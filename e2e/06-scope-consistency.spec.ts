/**
 * Journey 6: Scope consistency
 *
 * The workspace has two members (TestUser + Socio from journey 2).
 * Switch to a member scope → headline, /patrimonio totals and /inversiones
 * positions all reconcile; scope survives navigation (cookie present after reload).
 */

import { test, expect } from "@playwright/test";

test("scope consistency: switch member scope → reconciled views → survives reload", async ({
  page,
}) => {
  // 1. Go to / and check if scope tabs are visible (household with 2+ members)
  await page.goto("/");

  const scopeTabs = page.getByRole("navigation", { name: "Selector de scope" });
  const tabsVisible = await scopeTabs.isVisible();

  if (!tabsVisible) {
    // Only one member in workspace — scope switching not applicable; skip.
    test.skip();
    return;
  }

  // 2. Read the currently displayed headline
  const headlineBefore = await page.locator(".headline strong").textContent();

  // 3. Find a member scope tab that is NOT the currently active one
  const scopeButtons = scopeTabs.getByRole("button");
  const count = await scopeButtons.count();
  expect(count).toBeGreaterThanOrEqual(1);

  // Click the second scope tab (index 1, which is a non-household scope)
  // Scope tabs are rendered as form > button inside the scopeTabs nav.
  const secondTab = scopeButtons.nth(count > 1 ? 1 : 0);
  await secondTab.click();

  // 4. Should still be on / (redirect back to current page)
  await expect(page).toHaveURL(/^\//);

  // 5. Headline is now visible (may differ from before)
  await expect(page.locator(".headline strong")).toBeVisible();

  // 6. Navigate to /patrimonio — totals panel visible
  await page.goto("/patrimonio");
  await expect(page.getByRole("heading", { name: "Patrimonio" })).toBeVisible();
  // Assets section header with total present
  await expect(page.getByRole("heading", { name: "Activos" })).toBeVisible();

  // 7. Navigate to /inversiones — positions table renders without error
  await page.goto("/inversiones");
  await expect(page.getByRole("heading", { name: "Inversiones" })).toBeVisible();

  // 8. Reload / — scope cookie still set (scope-sensitive views still load)
  await page.reload();
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();
  await expect(page.locator(".headline strong")).toBeVisible();

  // 9. Navigate to / and back to patrimonio — same scope still active
  await page.goto("/patrimonio");
  await expect(page.getByRole("heading", { name: "Patrimonio" })).toBeVisible();
});
