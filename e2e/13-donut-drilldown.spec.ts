/**
 * Journey 13: Donut segments drill (#79)
 *
 * Each tier-donut segment is a native SVG anchor to its group's drilldown,
 * coherent with the decomposition bands: cash and market → drill=liquid,
 * retirement and illiquid → drill=rest, housing → drill=housing. Links
 * compose with view= (the selected Vista survives) and need zero client JS.
 * With no holdings the donut is not drawn — the drill URLs stay bookmarkable.
 */

import { test, expect } from "@playwright/test";

/** Mirror of the domain's DRILL_GROUP_BY_TIER (#79). */
const DRILL_BY_TIER: Record<string, string> = {
  cash: "liquid",
  market: "liquid",
  retirement: "rest",
  illiquid: "rest",
  housing: "housing",
};

test("every donut segment links to its tier's drill group", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  // Whatever segments the data produces, each one's destination must match
  // its tier — the same mapping the decomposition bands use.
  const segmentLinks = page.locator(".tierDonut a");
  const count = await segmentLinks.count();

  for (let i = 0; i < count; i += 1) {
    const link = segmentLinks.nth(i);
    const segmentClass = await link.locator("path").getAttribute("class");
    const tier = Object.keys(DRILL_BY_TIER).find((candidate) =>
      segmentClass?.includes(candidate),
    );

    expect(tier, `unknown donut segment class: ${segmentClass}`).toBeTruthy();
    await expect(link).toHaveAttribute(
      "href",
      new RegExp(`drill=${DRILL_BY_TIER[tier!]}`),
    );
    // Discernible accessible name: tier label + destination.
    await expect(link).toHaveAttribute("aria-label", /desglose/);
  }
});

test("donut segment click lands in the drill view, preserving the Vista", async ({
  page,
}) => {
  // Enter under the liquid Vista so preservation is observable.
  await page.goto("/?view=liquid");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  const segmentLink = page.locator(".tierDonut a").first();

  if ((await segmentLink.count()) > 0) {
    await expect(segmentLink).toHaveAttribute("href", /view=liquid/);
    await expect(segmentLink).toHaveAttribute(
      "href",
      /drill=(liquid|rest|housing)/,
    );
    // A thin annular wedge has no reliable bounding-box center to aim a
    // pointer at; a dispatched click activates the native anchor the same
    // way (no client JS involved either way).
    await segmentLink.dispatchEvent("click");
  } else {
    // No holdings yet ⇒ no donut. The drill URL is still bookmarkable.
    await page.goto("/?view=liquid&drill=liquid");
  }

  // We land in the drill view with the Vista intact.
  await expect(page).toHaveURL(/drill=(liquid|rest|housing)/);
  await expect(page).toHaveURL(/view=liquid/);
  await expect(page.locator(".drillPanel")).toBeVisible();

  // And the breadcrumb back keeps preserving it (same contract as #76/#77).
  await expect(page.locator(".drillBreadcrumb")).toHaveAttribute(
    "href",
    /view=liquid/,
  );
});
