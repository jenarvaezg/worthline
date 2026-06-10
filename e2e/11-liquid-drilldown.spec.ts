/**
 * Journey 11: Liquid drilldown (#76)
 *
 * From the home, the decomposition chart's liquid band/legend entry links to
 * the drill view (drill=liquid, composable with view=). The drill panel
 * renders in place of the decomposition chart with a breadcrumb back. With
 * single-day data (one snapshot per scope, as in this serial run) the
 * decomposition chart itself may not render yet — the drill URL is still
 * bookmarkable, and the drill charts show the one-line placeholders.
 */

import { test, expect } from "@playwright/test";

test("liquid drilldown: band/legend link → drill panel → breadcrumb back", async ({
  page,
}) => {
  // 1. Home renders.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 2. Enter the drill. With ≥2 snapshots the legend's "Líquido" entry (and
  //    the band itself) is a link; with single-snapshot data the chart is not
  //    drawn yet, so navigate to the bookmarkable drill URL directly.
  const legendLink = page.locator(".decompositionLegend a");

  if ((await legendLink.count()) > 0) {
    await expect(legendLink.first()).toHaveAttribute("href", /drill=liquid/);
    await legendLink.first().click();
  } else {
    await page.goto("/?drill=liquid");
  }

  await expect(page).toHaveURL(/drill=liquid/);

  // 3. The drill panel renders in place of the decomposition chart:
  //    breadcrumb + heading, and either the cash-vs-market chart or its
  //    placeholder (single-day data ⇒ placeholder is correct behavior).
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText(
    "Líquido · caja y mercado",
  );
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
