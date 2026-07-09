/**
 * Journey 25: Debts drilldown (#145)
 *
 * The composition chart sits a single aggregated debt band BELOW the zero
 * baseline. That band — and its "Deudas" legend entry — links to the debts
 * drill (drill=debts, composable with view=), mirroring the liquid (#76) and
 * rest/housing (#77) drills. The drill panel renders in place of the
 * composition chart: a breadcrumb back (preserving the Vista), the aggregate
 * "Deudas" series, and per-debt small multiples (one sparkline per liability,
 * secured AND unsecured).
 *
 * State / constraints this journey is built around:
 *   - The debt band only renders when a period carries a liability with balance
 *     > 0 (composition-chart.ts: `hasDebt = points.some(p => p.debtsMinor > 0)`).
 *   - A per-debt small multiple needs ≥2 captured points in the window
 *     (drilldown.ts buildDrillHoldingMultiples); with a single debt-day the
 *     multiples show only their empty placeholder, like the liquid/rest drills
 *     on single-day data.
 *   - By the time this journey runs, journey 22 has REPLACED the workspace via
 *     an "import and replace" (so the seed members/holdings are gone) and
 *     journeys 23–24 have populated a real-estate asset and a mortgage with a
 *     past amortization plan — leaving a live liability whose balance has been
 *     frozen across many past months. That liability is the household scope's
 *     debt, so the band, the aggregate series, and a real per-debt multiple all
 *     render here without this journey having to stage its own history.
 *
 * The "Ya no vigente" flag for a liability that has left the portfolio but
 * keeps its frozen history is exercised by the domain unit tests
 * (packages/domain/src/drilldown.test.ts) — reproducing it here would require a
 * debt present in a PAST-day snapshot then removed, which a single shared
 * wall-clock day cannot stage deterministically.
 *
 * Note (#142): the dashboard composition chart's legend is `.compositionLegend`;
 * `.decompositionLegend` now lives only INSIDE the drill panel's stack section.
 */

import { expect, test } from "./fixtures";

/** Pin the Hogar (household) scope — it aggregates every member's liabilities.
 * By the time this journey runs the serial workspace is individual (journey 19
 * re-onboards solo, journey 20 imports an individual file), so the scope
 * selector is hidden — the lone person IS the household (#269) and it is already
 * the only, active, default scope. The click is a no-op then; in a household
 * workspace (multiple members) we click "Hogar" as before. */
async function pinHouseholdScope(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const scopeNav = page.getByRole("navigation", { name: "Selector de ámbito" });
  if ((await scopeNav.count()) === 0) {
    return;
  }
  const hogar = scopeNav.getByRole("button", { name: "Hogar" });
  await hogar.click();
  await expect(hogar).toHaveClass(/active/);
}

test("debts drilldown: band/legend link → aggregate series + per-debt multiples → breadcrumb back", async ({
  page,
}) => {
  // 0. Pin the household scope: earlier journeys leave a member scope in the
  //    cookie. The household scope aggregates every liability, so the debt the
  //    previous journeys created is guaranteed present. The scope choice is a
  //    cookie (POST /scope), so it sticks across the drill's zero-JS <a> nav.
  await pinHouseholdScope(page);
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // 1. The composition legend's "Deudas" entry links to the debts drill.
  const legendLink = page.locator('.compositionLegend a[href*="drill=debts"]');
  await expect(legendLink).toHaveText("Deudas");
  await expect(legendLink).toHaveAttribute("href", /drill=debts/);

  // 1b. The aggregated debt slab below the baseline is itself a native SVG
  //     anchor to the same drill (ADR 0009 — navigation with zero client JS).
  await expect(
    page
      .locator('svg.compositionChart a[href*="drill=debts"] rect.compositionDebt')
      .first(),
  ).toBeVisible();

  // 2. Following the legend link opens the drill panel in place of the chart.
  await legendLink.click();
  await expect(page).toHaveURL(/drill=debts/);

  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText("Deudas · obligaciones");

  // 3. The panel shows the aggregate "Deudas" series. With a multi-month debt
  //    history the stacked chart draws (its legend names a single "Deudas"
  //    band); the empty placeholder is tolerated only as a defensive fallback.
  await expect(
    page.locator(".drillChart").or(page.locator(".drillEmpty")).first(),
  ).toBeVisible();
  const stackLegend = page.locator(".decompositionLegend");
  await expect(stackLegend).toBeVisible();
  await expect(stackLegend.getByText("Deudas")).toBeVisible();

  // 4. Per-debt small multiples: at least one liability has the ≥2 captured
  //    points needed to draw a tile. Assert the section renders with a tile that
  //    carries a label, a sparkline, and a money figure — and that a live debt
  //    is NOT flagged "Ya no vigente". (Asserted generically rather than by a
  //    fixed debt name: which debt survives the earlier journeys is their
  //    concern, not this one's; the no-longer-held copy itself is unit-tested.)
  const multiples = page.locator(".drillMultiples");
  await expect(multiples).toBeVisible();
  const firstTile = multiples.locator(".drillMultiple").first();
  await expect(firstTile).toBeVisible();
  await expect(firstTile.locator(".drillMultipleLabel")).not.toBeEmpty();
  await expect(firstTile.locator("svg.drillSparkline")).toBeVisible();
  // A live debt shows a money figure with the € symbol. Retired holdings are
  // now dropped from the cards entirely (ADR 0032), so there is no "gone"
  // placeholder to guard against.
  const liveTile = multiples.locator(".drillMultiple").first();
  await expect(liveTile.locator("b")).toContainText("€");

  // 5. Breadcrumb returns to the composition — no drill param, chart slot back.
  await page.locator(".drillBreadcrumb").click();
  await expect(page).not.toHaveURL(/drill=/);
  await expect(page.locator(".drillPanel")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Evolución del patrimonio" }),
  ).toBeVisible();
});

test("debts drilldown: the selected Vista survives entering and leaving", async ({
  page,
}) => {
  // Enter the debts drill under the liquid Vista directly (bookmarkable URL).
  await page.goto("/?view=liquid&drill=debts");
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText("Deudas · obligaciones");

  // The breadcrumb preserves the Vista.
  const breadcrumb = page.locator(".drillBreadcrumb");
  await expect(breadcrumb).toHaveAttribute("href", /view=liquid/);
  await breadcrumb.click();

  await expect(page).toHaveURL(/view=liquid/);
  await expect(page).not.toHaveURL(/drill=/);
});
