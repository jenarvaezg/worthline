/**
 * Journey 11: Liquid drilldown (#76)
 *
 * From the home, the composition chart's liquid band/legend entry links to
 * the drill view (drill=liquid, composable with view=). The drill panel
 * renders in place of the composition chart with a breadcrumb back. The
 * globalSetup seeds a second snapshot day so the composition chart always
 * renders during the serial run.
 *
 * Note (#142): the dashboard composition chart's legend is `.compositionLegend`;
 * `.decompositionLegend` now lives only INSIDE the drill panel's stack section.
 */

import { clickSectionTab, expect, homeBody, test } from "./fixtures";

test("liquid drilldown: band/legend link → drill panel → breadcrumb back", async ({
  page,
}) => {
  // 1. Home renders.
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 2. The composition legend's "Líquido" entry (cash, the first band, drills to
  //    liquid) is a link — the seeded second snapshot day guarantees the chart
  //    renders.
  const legendLink = page.locator('.compositionLegend a[href*="drill=liquid"]');
  await expect(legendLink.first()).toHaveAttribute("href", /drill=liquid/);

  // Tag the live document; surviving the open+close round-trip PROVES the drill
  // is CLIENT state (S4 #520) — no document navigation, so scroll is preserved
  // (interaction-patterns §2/§5). The round-trip the S0 baseline #516 measured
  // is gone.
  await page.evaluate(() => {
    (window as unknown as { __wlNoReload?: string }).__wlNoReload = "kept";
  });

  await legendLink.first().click();

  await expect(page).toHaveURL(/drill=liquid/);

  // 3. The drill panel renders in place of the decomposition chart — instantly,
  //    from the shipped matrix cross, with no new document:
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText("Líquido · caja y mercado");
  await expect(
    page.locator(".drillChart").or(page.locator(".drillEmpty")).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __wlNoReload?: string }).__wlNoReload,
    ),
  ).toBe("kept");

  // 4. Breadcrumb returns home — no drill param, decomposition slot back, still
  //    client-side (the sentinel survives).
  await page.locator(".drillBreadcrumb").click();
  await expect(page).not.toHaveURL(/drill=/);
  await expect(
    page.getByRole("region", { name: "Evolución del patrimonio" }),
  ).toBeVisible();
  await expect(page.locator(".drillPanel")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __wlNoReload?: string }).__wlNoReload,
    ),
  ).toBe("kept");
});

test("topnav navigation does not cause a full document reload (soft nav, #517)", async ({
  page,
}) => {
  // Navigate to home and tag the live document with a sentinel.
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __wlNoReload?: string }).__wlNoReload = "kept";
  });

  // Click a topnav link to a different top-level section. Waiting for the home's
  // body is not decoration: the heading above is chrome, so without it this leaves
  // /app mid-reveal and the home's body lands on screen over /patrimonio (#1351).
  await clickSectionTab(page, "Patrimonio", homeBody(page));

  await expect(page).toHaveURL(/\/patrimonio/);

  // If the click fell through to a hard navigation the sentinel would be gone.
  const sentinel = await page.evaluate(
    () => (window as unknown as { __wlNoReload?: string }).__wlNoReload,
  );
  expect(sentinel).toBe("kept");
});

// Note: there is no view transition to assert on. #1379 measured a production
// build with a `document.startViewTransition` probe and counted zero calls —
// React only opens a transition from inside a `<ViewTransition>` boundary and
// the app has none — then retired the layer (ADR 0036 §5). An earlier version of
// this comment blamed the turbopack dev server and "named transition elements";
// both halves were wrong, and the mistake cost #1351 an investigation. What the
// test above covers is the acceptance that actually holds: the topnav click is a
// soft navigation, not a document reload.

test("liquid drilldown: the selected Vista survives entering and leaving", async ({
  page,
}) => {
  // Enter the drill under the liquid Vista directly (bookmarkable URL).
  await page.goto("/app?view=liquid&drill=liquid");
  await expect(page.locator(".drillPanel")).toBeVisible();

  // The breadcrumb preserves the Vista.
  const breadcrumb = page.locator(".drillBreadcrumb");
  await expect(breadcrumb).toHaveAttribute("href", /view=liquid/);
  await breadcrumb.click();

  await expect(page).toHaveURL(/view=liquid/);
  await expect(page).not.toHaveURL(/drill=/);
});
