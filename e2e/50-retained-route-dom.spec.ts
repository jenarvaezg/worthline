/**
 * Journey 50: the suite only sees the route that is on screen (#1351).
 *
 * Since #1229 (`cacheComponents`) Next keeps the route you leave in the document,
 * hidden with `<Activity mode="hidden">`, so state and DOM survive going back and
 * forth. That is the documented contract — and it means a page-scoped query can
 * answer about a page the person has already left. `visible-page.ts` narrows every
 * page-scoped query for exactly that reason; this journey is the proof that it
 * works, in both directions.
 *
 * The three tests are deliberately different in kind:
 *
 * 1. The PROBE is hermetic (`setContent`, no app, no server) and pins which
 *    Playwright queries filter by visibility. That table is the whole basis for
 *    which methods get narrowed, so it must be measured rather than remembered:
 *    the day an upgrade changes an answer, this names the query that moved instead
 *    of surfacing as a strict-mode violation somewhere in the middle of the suite.
 *    It walks `QUERIES_THAT_SEE_HIDDEN_DOM` itself and `HIDDEN_TARGETS` is
 *    exhaustive over it, so a method cannot join that list unmeasured.
 *
 * 2. The NAVIGATION test proves the same thing against the real app, where the
 *    hidden DOM is a whole retained route rather than a `display: none` div. It
 *    leaves through a link in the BODY — the safe path, because a body link is not
 *    clickable until the body is on screen.
 *
 * 3. The CHROME test covers the path that actually broke: a topnav tab, which
 *    paints from the prefetched shell and is therefore clickable while the body it
 *    is leaving is still unrevealed. That is #1351's open symptom, now measured —
 *    the leaver's body revealed AFTER the navigation and stayed ON SCREEN over the
 *    destination. It samples across a window instead of glancing once, because the
 *    defect is a window and a single retrying assertion cannot see one.
 */

import { QUERIES_THAT_SEE_HIDDEN_DOM } from "@e2e/visible-queries";
import type { Locator, Page } from "@playwright/test";

import { clickSectionTab, expect, homeBody, test, wholeDocument } from "./fixtures";

/** Home-only hook: the dashboard's FIRE panel (`dashboard-content.tsx`). */
const HOME_FIRE_PANEL = ".firePanel.section";

/** Its /objetivos counterpart — the pair whose shared name collided in #1351. */
const OBJETIVOS_FIRE_PANEL = ".firePanel.objetivosFirePanel";

/**
 * One hidden target per narrowed query. Keyed by the query name so the type is
 * exhaustive over {@link QUERIES_THAT_SEE_HIDDEN_DOM}: adding a method there
 * without a probe here does not compile.
 */
const HIDDEN_TARGETS: Record<
  (typeof QUERIES_THAT_SEE_HIDDEN_DOM)[number],
  { html: string; query: (page: Page) => Locator }
> = {
  locator: {
    html: `<p class="errorBand">Las unidades son obligatorias.</p>`,
    query: (page) => page.locator(".errorBand"),
  },
  getByLabel: {
    html: `<label>Unidades<input name="units"></label>`,
    query: (page) => page.getByLabel("Unidades"),
  },
  getByText: {
    html: `<p>El precio por unidad es obligatorio.</p>`,
    query: (page) => page.getByText("El precio por unidad es obligatorio."),
  },
  getByPlaceholder: {
    html: `<input placeholder="100,00">`,
    query: (page) => page.getByPlaceholder("100,00"),
  },
  getByTitle: {
    html: `<abbr title="Valor calculado">≈</abbr>`,
    query: (page) => page.getByTitle("Valor calculado"),
  },
  getByAltText: {
    html: `<img alt="Anverso de la moneda" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`,
    query: (page) => page.getByAltText("Anverso de la moneda"),
  },
  getByTestId: {
    html: `<div data-testid="retained-probe"></div>`,
    query: (page) => page.getByTestId("retained-probe"),
  },
};

test("visibility probe: every narrowed query sees hidden DOM, and getByRole does not", async ({
  page,
}) => {
  // The scoping is the subject here, so the raw side queries through the
  // unscoped page.
  const unscoped = wholeDocument(page);

  // Exactly one of each target, all of them inside a hidden subtree: a count of
  // 0 means the query filters by visibility, 1 means it does not.
  await unscoped.setContent(`
    <div style="display:none">
      <section role="region" aria-label="FIRE">retained route</section>
      ${QUERIES_THAT_SEE_HIDDEN_DOM.map((method) => HIDDEN_TARGETS[method].html).join("\n")}
    </div>
  `);

  for (const method of QUERIES_THAT_SEE_HIDDEN_DOM) {
    const { query } = HIDDEN_TARGETS[method];
    await expect(
      query(unscoped),
      `page.${method}() does not filter by visibility — that is why it is narrowed`,
    ).toHaveCount(1);
    await expect(
      query(page),
      `the suite's page must not hand back hidden DOM via ${method}()`,
    ).toHaveCount(0);
  }

  // The one query left alone, because it filters on its own. If this ever returns
  // 1, `QUERIES_THAT_SEE_HIDDEN_DOM` has to grow by one.
  await expect(
    unscoped.getByRole("region", { name: "FIRE" }),
    "getByRole is not narrowed because it already filters by visibility",
  ).toHaveCount(0);
});

test("a retained route stays in the document, and the suite's page ignores it", async ({
  page,
}) => {
  // The familia persona has FIRE configured, so both /app and /objetivos render a
  // FIRE panel — which is what made this collide in the first place (#1351).
  await page.goto("/demo?persona=familia");
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator(HOME_FIRE_PANEL)).toHaveCount(1);

  // A client navigation, not a document load: only a client navigation retains
  // the outgoing route.
  await page.getByRole("link", { name: /Ver objetivos/ }).click();
  await page.waitForURL(/\/objetivos/, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "FIRE", exact: true })).toBeVisible();

  // What the suite must never see again: the home's own FIRE panel. This is also
  // the watchdog for #1351's open symptom — the leaver still being ON SCREEN after
  // the entrant painted, which CI saw twice and no local run has reproduced.
  await expect(page.locator(HOME_FIRE_PANEL)).toHaveCount(0);

  // And it is still there — hidden, by design. A failure here is Next changing
  // the retention contract, not the app breaking: re-read
  // `next/dist/docs/01-app/02-guides/preserving-ui-state.md` before touching
  // `visible-page.ts`, because the narrowing exists for this.
  await expect(
    wholeDocument(page).locator(HOME_FIRE_PANEL),
    "the route left behind should still be in the document (cacheComponents keeps up to 3)",
  ).toHaveCount(1);
});

/**
 * The number of on-screen FIRE regions, sampled repeatedly for `windowMs`.
 *
 * A single retrying assertion cannot see this: `toHaveCount(0)` passes the moment
 * the count reaches 0 and never reports the frames before it. The defect is a
 * WINDOW during which two routes are on screen at once, so the sentinel has to
 * watch rather than glance — this is the same measurement that found the cause.
 */
async function worstOnScreenFireCount(page: Page, windowMs: number): Promise<number> {
  const fire = page.getByRole("region", { name: "FIRE", exact: true });
  const deadline = Date.now() + windowMs;
  let worst = 0;
  do {
    worst = Math.max(worst, await fire.count());
  } while (Date.now() < deadline && worst < 2);
  return worst;
}

test("leaving a route through the chrome does not leave its body on screen", async ({
  page,
}) => {
  // #1351's own open symptom, and the other direction of the same contract:
  // `<Activity>`'s hide only reaches the nodes React already owns, so a body still
  // inside React's streaming holder when you navigate is revealed afterwards, into
  // an already-hidden route whose new container nothing has hidden yet — ON SCREEN,
  // over the destination. `docs/interaction-patterns.md` §5.1 carries the mechanism
  // and the measurement; `clickSectionTab` carries the guard.
  //
  // Honest limit: this walks the path that broke, at full speed, so it is a watchdog
  // rather than a proof of the negative — dropping the guard inside `clickSectionTab`
  // would go red only under load.
  await page.goto("/demo?persona=familia");
  await expect(page).toHaveURL(/\/app$/);

  await clickSectionTab(page, "Objetivos", homeBody(page));
  await page.waitForURL(/\/objetivos/, { timeout: 15_000 });

  // Wait for the ENTRANT's own panel before sampling. Without this a destination
  // that is merely slow reads as the defect: the sample would find nothing on screen
  // and the count assertion below would fail with «two routes» for the opposite
  // reason — exactly on the starved runner this test exists for.
  await expect(page.locator(OBJETIVOS_FIRE_PANEL)).toBeVisible();

  expect(
    await worstOnScreenFireCount(page, 2_000),
    "two routes were on screen at once — the route being left was not hidden (#1351)",
  ).toBe(1);
  await expect(page.locator(HOME_FIRE_PANEL)).toHaveCount(0);
});
