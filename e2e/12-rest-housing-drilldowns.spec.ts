/**
 * Journey 12: Rest and housing drilldowns (#77)
 *
 * From the home, the composition chart's rest band/legend entry links to
 * the retirement-vs-illiquid drill (drill=rest), and the housing band/legend
 * entry links straight to the per-property small multiples (drill=housing —
 * a single tier, so no stacked chart, ever). Both compose with view=. The
 * globalSetup seeds a second snapshot day so the composition chart always
 * renders during the serial run.
 *
 * Note (#142): the dashboard composition chart's legend is `.compositionLegend`;
 * `.decompositionLegend` now lives only INSIDE the drill panel's stack section.
 */

import { test, expect } from "./fixtures";

test("rest drilldown: band/legend link → stack panel → breadcrumb back", async ({
  page,
}) => {
  // 1. Home renders.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 2. The composition legend's rest-group entries (the "A plazo" and "Ilíquido"
  //    bands both drill to rest) are links — the seeded second snapshot day
  //    guarantees the chart renders. Take the first rest-bound legend link.
  const legendLink = page.locator('.compositionLegend a[href*="drill=rest"]');
  await expect(legendLink.first()).toHaveText(/A plazo|Ilíquido/);
  await legendLink.first().click();

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

  const legendLink = page.locator('.compositionLegend a[href*="drill=housing"]');
  await expect(legendLink.first()).toHaveText("Vivienda");
  await legendLink.first().click();

  await expect(page).toHaveURL(/drill=housing/);

  // 2. The housing panel renders multiples only — no stacked chart and no
  //    stack placeholder, by design (single tier).
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText("Vivienda · propiedades");
  await expect(page.locator(".drillChart")).toHaveCount(0);
  await expect(
    page.locator(".drillMultiples").or(page.locator(".drillEmpty")).first(),
  ).toBeVisible();

  // 3. Breadcrumb returns home.
  await page.locator(".drillBreadcrumb").click();
  await expect(page).not.toHaveURL(/drill=/);
  await expect(page.locator(".drillPanel")).toHaveCount(0);
});
