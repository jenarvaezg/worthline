/**
 * Journey 26: Composition temporal range (#144)
 *
 * The composition chart's temporal window is URL state (`range=1y|3y|5y`, with
 * `all` as the clean default), surfaced as a set of pill links
 * (`.rangeTabs`). Only the ranges the history actually SPANS are offered: a
 * bounded range appears only when the history is longer than its window
 * (composition-chart.ts: `RANGE_MONTHS[range] < spanMonths`), and with a single
 * option the control hides itself (composition-range-controls.tsx).
 *
 * State note: by the time this journey runs, earlier journeys have injected
 * historical snapshots spanning several years — journey 23 adds a 2024 housing
 * anchor and journey 24 an amortization plan starting ~6 years ago. The
 * household scope's history therefore spans well over five years, so the FULL
 * control is offered (1A/3A/5A/Todo). We pin that scope, assert the control is
 * present and reflects the span, and verify a bounded range sets cleanly and
 * round-trips — including through a drill (#145).
 */

import { test, expect } from "./fixtures";

/** Pin the household scope, whose accumulated history spans the most years.
 * By the time this journey runs the serial workspace is individual (journey 19
 * re-onboards solo, journey 20 imports an individual file), so the scope
 * selector is hidden — the lone person IS the household (#269) and it is already
 * the only, active, default scope carrying that history. The click is a no-op
 * then; in a household workspace (multiple members) we click "Hogar" as before. */
async function pinHouseholdScope(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const scopeNav = page.getByRole("navigation", { name: "Selector de scope" });
  if ((await scopeNav.count()) === 0) {
    return;
  }
  const hogar = scopeNav.getByRole("button", { name: "Hogar" });
  await hogar.click();
  await expect(hogar).toHaveClass(/active/);
}

test("range control: offered when the history spans years, with the bounded ranges + Todo", async ({
  page,
}) => {
  await pinHouseholdScope(page);

  const evolution = page.getByRole("region", { name: "Evolución del patrimonio" });
  await expect(evolution).toBeVisible();

  // The control is present (multi-year history) and exposes the always-on
  // "Todo" plus at least one bounded range. "Todo" is the active default.
  const rangeTabs = evolution.getByRole("navigation", {
    name: "Rango temporal de la composición",
  });
  await expect(rangeTabs).toBeVisible();
  await expect(rangeTabs.getByRole("link", { name: "Todo" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(await rangeTabs.getByRole("link").count()).toBeGreaterThanOrEqual(2);

  // The composition chart renders alongside the control.
  await expect(
    page.locator("svg.compositionChart").or(page.locator(".compositionEmpty")).first(),
  ).toBeVisible();
});

test("range control: selecting a bounded pill sets the range and marks it active", async ({
  page,
}) => {
  await pinHouseholdScope(page);

  const rangeTabs = page.getByRole("navigation", {
    name: "Rango temporal de la composición",
  });
  // The 1A pill links to range=1y and, once followed, becomes the active range.
  const oneYear = rangeTabs.getByRole("link", { name: "1A" });
  await expect(oneYear).toHaveAttribute("href", /range=1y/);
  await oneYear.click();

  await expect(page).toHaveURL(/range=1y/);
  const activeOneYear = page
    .getByRole("navigation", { name: "Rango temporal de la composición" })
    .getByRole("link", { name: "1A" });
  await expect(activeOneYear).toHaveAttribute("aria-current", "true");
  await expect(
    page.locator("svg.compositionChart").or(page.locator(".compositionEmpty")).first(),
  ).toBeVisible();
});

test("range param: composes with a drill and round-trips through the breadcrumb", async ({
  page,
}) => {
  await pinHouseholdScope(page);

  // The temporal range composes with a drill (#145): entering the debts drill
  // under a 3y window must render the drill panel AND thread `range=3y` back
  // through the breadcrumb, so leaving the drill keeps the chosen window.
  // (The debts drill needs a liability with balance > 0 — journey 25 created
  // one in the household scope earlier in this serial run.)
  await page.goto("/?drill=debts&range=3y");
  await expect(page.locator(".drillPanel")).toBeVisible();
  await expect(page.locator(".drillHeader h3")).toHaveText("Deudas · obligaciones");

  // The breadcrumb back to the composition preserves the range.
  const breadcrumb = page.locator(".drillBreadcrumb");
  await expect(breadcrumb).toHaveAttribute("href", /range=3y/);
  await breadcrumb.click();

  await expect(page).toHaveURL(/range=3y/);
  await expect(page).not.toHaveURL(/drill=/);
  await expect(page.locator(".drillPanel")).toHaveCount(0);

  // Back on the full composition, the 3A range is the active pill.
  await expect(
    page
      .getByRole("navigation", { name: "Rango temporal de la composición" })
      .getByRole("link", { name: "3A" }),
  ).toHaveAttribute("aria-current", "true");
});
