/**
 * Home FIRE glance card (PRD #507, S1 #509).
 *
 * Verifies the compact glance card renders on the dashboard for a FIRE-configured
 * persona (familia), and that the removed detail (3 scenarios, trajectory SVG) is
 * no longer present on the home. Runs against the DEMO build (no login required;
 * familia has a configured FIRE target).
 */
import { expect, test } from "@playwright/test";

test("home FIRE glance: compact card renders, detail removed", async ({ page }) => {
  // Choose the familia persona — it has a configured FIRE target.
  await page.goto("/demo");
  await page.getByRole("button", { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  const firePanel = page.getByRole("region", { name: "FIRE" });
  await expect(firePanel).toBeVisible();

  // Compact glance elements ARE present.
  await expect(firePanel.getByRole("link", { name: /Ver objetivos/ })).toHaveAttribute(
    "href",
    "/objetivos",
  );
  await expect(firePanel.locator(".fireBar")).toBeVisible();

  // Detail elements removed from home: 3-scenario table, trajectory SVG.
  await expect(firePanel.locator(".fireScenarios")).toHaveCount(0);
  await expect(firePanel.locator(".fireTrajectory")).toHaveCount(0);
  // FIRE number and eligible-assets metrics removed.
  await expect(firePanel.getByText("Número FIRE")).toHaveCount(0);
  await expect(firePanel.getByText("Activos elegibles")).toHaveCount(0);
});
