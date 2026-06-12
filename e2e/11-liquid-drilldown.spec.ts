/**
 * Journey 11: Liquid drilldown (#76)
 *
 * From the home, the decomposition chart's liquid band/legend entry links to
 * the drill view (drill=liquid, composable with view=). The drill panel
 * renders in place of the decomposition chart with a breadcrumb back. The
 * globalSetup seeds a second snapshot day so the decomposition chart always
 * renders during the serial run.
 */

import { test, expect } from "./fixtures";

test("liquid drilldown: band/legend link → drill panel → breadcrumb back", async ({
  page,
}) => {
  // 1. Home renders.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 2. The legend's "Líquido" entry (and the band itself) is a link — the
  //    seeded second snapshot day guarantees the decomposition chart renders.
  const legendLink = page.locator(".decompositionLegend a");
  await expect(legendLink.first()).toHaveAttribute("href", /drill=liquid/);
  await legendLink.first().click();

  await expect(page).toHaveURL(/drill=liquid/);

  // 3. The drill panel renders in place of the decomposition chart:
  //    breadcrumb + heading, and either the cash-vs-market chart or its
  //    placeholder (single-day data ⇒ placeholder is correct behavior).
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText("Líquido · caja y mercado");
  await expect(
    page.locator(".drillChart").or(page.locator(".drillEmpty")).first(),
  ).toBeVisible();

  // 4. Breadcrumb returns home — no drill param, decomposition slot back.
  await page.locator(".drillBreadcrumb").click();
  await expect(page).not.toHaveURL(/drill=/);
  await expect(
    page.getByRole("region", { name: "Evolución del patrimonio" }),
  ).toBeVisible();
  await expect(page.locator(".drillPanel")).toHaveCount(0);
});

test("liquid drilldown: the selected Vista survives entering and leaving", async ({
  page,
}) => {
  // Enter the drill under the liquid Vista directly (bookmarkable URL).
  await page.goto("/?view=liquid&drill=liquid");
  await expect(page.locator(".drillPanel")).toBeVisible();

  // The breadcrumb preserves the Vista.
  const breadcrumb = page.locator(".drillBreadcrumb");
  await expect(breadcrumb).toHaveAttribute("href", /view=liquid/);
  await breadcrumb.click();

  await expect(page).toHaveURL(/view=liquid/);
  await expect(page).not.toHaveURL(/drill=/);
});
