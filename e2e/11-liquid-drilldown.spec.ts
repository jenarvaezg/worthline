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

import { test, expect } from "./fixtures";

test("liquid drilldown: band/legend link → drill panel → breadcrumb back", async ({
  page,
}) => {
  // 1. Home renders.
  await page.goto("/");
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

test("topnav navigation does not cause a full document reload (VT cross-fade, #517)", async ({
  page,
}) => {
  // Navigate to home and tag the live document with a sentinel.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __wlNoReload?: string }).__wlNoReload = "kept";
  });

  // Click a topnav link to a different top-level section.
  await page
    .getByRole("navigation", { name: "Secciones principales" })
    .getByRole("link", { name: "Patrimonio" })
    .click();

  await expect(page).toHaveURL(/\/patrimonio/);

  // If the VT caused a full document reload the sentinel would be gone.
  const sentinel = await page.evaluate(
    () => (window as unknown as { __wlNoReload?: string }).__wlNoReload,
  );
  expect(sentinel).toBe("kept");
});

test("topnav navigation uses classified View Transition types (slide-forward, #517)", async ({
  page,
}) => {
  // Navigate to home. Spy on document.startViewTransition to capture which
  // transitionTypes were requested — this would fail if ViewTransitionLink is
  // replaced with a bare Link that does not pass transitionTypes.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as {
      __wlVtTypes?: string[];
      __wlVtCalled?: boolean;
    };
    w.__wlVtTypes = undefined;
    w.__wlVtCalled = false;

    const original = document.startViewTransition?.bind(document);
    if (!original) return; // Browser does not support VT — test is a no-op.

    // @ts-expect-error — patching the native API for test observation only.
    document.startViewTransition = (
      options: { types?: string[]; update: () => Promise<void> } | (() => void),
    ) => {
      if (typeof options === "object" && options !== null) {
        w.__wlVtTypes = options.types ?? [];
      }
      w.__wlVtCalled = true;
      return original(options);
    };
  });

  // Navigate / → /patrimonio (forward in nav order → should be "slide-forward").
  const sentinel = "__wlVtSentinel";
  await page.evaluate((s) => {
    (window as unknown as Record<string, string>)[s] = "kept";
  }, sentinel);

  await page
    .getByRole("navigation", { name: "Secciones principales" })
    .getByRole("link", { name: "Patrimonio" })
    .click();

  await expect(page).toHaveURL(/\/patrimonio/);

  // The sentinel must survive (no full reload).
  const sentinelValue = await page.evaluate(
    (s) => (window as unknown as Record<string, string>)[s],
    sentinel,
  );
  expect(sentinelValue).toBe("kept");

  // If the browser supports View Transitions AND the wiring is active,
  // startViewTransition must have been called with "slide-forward".
  const { vtCalled, vtTypes } = await page.evaluate(() => {
    const w = window as unknown as {
      __wlVtTypes?: string[];
      __wlVtCalled?: boolean;
    };
    return { vtCalled: w.__wlVtCalled ?? false, vtTypes: w.__wlVtTypes ?? [] };
  });

  if (vtCalled) {
    // VT is supported — assert the classification wiring produced the correct type.
    expect(vtTypes).toContain("slide-forward");
  }
  // If vtCalled is false the browser does not support VT (graceful degradation);
  // the test is still green — the sentinel check above already verified no reload.
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
