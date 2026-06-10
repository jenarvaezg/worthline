/**
 * Journey 12: Rest and housing drilldowns (#77)
 *
 * From the home, the decomposition chart's rest band/legend entry links to
 * the retirement-vs-illiquid drill (drill=rest), and the housing band/legend
 * entry links straight to the per-property small multiples (drill=housing —
 * a single tier, so no stacked chart, ever). Both compose with view=. With
 * single-day data (one snapshot per scope, as in this serial run) the
 * decomposition chart itself may not render yet — the drill URLs are still
 * bookmarkable, and the drill panels show their placeholders.
 */

import { test, expect } from "./fixtures";

test("rest drilldown: band/legend link → stack panel → breadcrumb back", async ({
  page,
}) => {
  // 1. Home renders.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 2. Enter the drill. With ≥2 snapshots the legend's "Resto" entry (and the
  //    band itself) is a link; with single-snapshot data the chart is not
  //    drawn yet, so navigate to the bookmarkable drill URL directly.
  const legendLink = page.locator('.decompositionLegend a[href*="drill=rest"]');

  if ((await legendLink.count()) > 0) {
    await expect(legendLink.first()).toHaveText("Resto");
    await legendLink.first().click();
  } else {
    await page.goto("/?drill=rest");
  }

  await expect(page).toHaveURL(/drill=rest/);

  // 3. The drill panel renders in place of the decomposition chart:
  //    breadcrumb + heading, and either the retirement-vs-illiquid chart or
  //    its placeholder (single-day data ⇒ placeholder is correct behavior).
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText(
    "Resto · jubilación e ilíquido",
  );
  await expect(
    page.locator(".drillChart").or(page.locator(".drillEmpty")).first(),
  ).toBeVisible();

  // 4. Breadcrumb returns home — no drill param, decomposition slot back.
  await page.locator(".drillBreadcrumb").click();
  await expect(page).not.toHaveURL(/drill=/);
  await expect(page.locator(".drillPanel")).toHaveCount(0);
});

test("housing drilldown: straight to per-property multiples, no stack", async ({
  page,
}) => {
  // 1. Home renders; the housing legend entry links to the drill when the
  //    decomposition chart is drawn.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  const legendLink = page.locator(
    '.decompositionLegend a[href*="drill=housing"]',
  );

  if ((await legendLink.count()) > 0) {
    await expect(legendLink.first()).toHaveText("Vivienda");
    await legendLink.first().click();
  } else {
    await page.goto("/?drill=housing");
  }

  await expect(page).toHaveURL(/drill=housing/);

  // 2. The housing panel renders multiples only — no stacked chart and no
  //    stack placeholder, by design (single tier).
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText(
    "Vivienda · propiedades",
  );
  await expect(page.locator(".drillChart")).toHaveCount(0);
  await expect(
    page.locator(".drillMultiples").or(page.locator(".drillEmpty")).first(),
  ).toBeVisible();

  // 3. Breadcrumb returns home.
  await page.locator(".drillBreadcrumb").click();
  await expect(page).not.toHaveURL(/drill=/);
  await expect(page.locator(".drillPanel")).toHaveCount(0);
});

test("rest drilldown: the selected Vista survives entering and leaving", async ({
  page,
}) => {
  // Enter the drill under the liquid Vista directly (bookmarkable URL).
  await page.goto("/?view=liquid&drill=rest");
  await expect(page.locator(".drillPanel")).toBeVisible();

  // The breadcrumb preserves the Vista.
  const breadcrumb = page.locator(".drillBreadcrumb");
  await expect(breadcrumb).toHaveAttribute("href", /view=liquid/);
  await breadcrumb.click();

  await expect(page).toHaveURL(/view=liquid/);
  await expect(page).not.toHaveURL(/drill=/);
});
