/**
 * Page-scoped queries ask about what is ON SCREEN, not about what is in the
 * document (#1351).
 *
 * With `cacheComponents` (#1229) Next does NOT unmount the route you leave: it
 * hides it with React `<Activity mode="hidden">` — `display: none` — and keeps up
 * to three routes in the document, so form drafts, scroll, open folds and playing
 * video survive going back and forth. That is documented behaviour, not a bug:
 * `apps/web/node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`,
 * which warns e2e suites about it in as many words: «Hidden Activity content has
 * `display: none` but remains in the document. […] DOM queries can find hidden
 * elements.»
 *
 * So after a client navigation the document holds the previous page too, and a
 * page-scoped query can latch onto it: a strict-mode violation when two nodes
 * match (loud, and the shape of #1351), or — worse, because it is silent — a
 * `.first()` / `.nth()` / `.count()` that answers about the page the person has
 * already left.
 *
 * ## Which queries actually filter, measured
 *
 * The Next guide says `getByRole` filters by visibility. Only `getByRole` does.
 * Probed in Chromium under Playwright 1.61 with exactly one of each target inside
 * a `display: none` subtree — a count of 0 means the query filters it out:
 *
 * | query                                | sees hidden DOM |
 * | ------------------------------------ | --------------- |
 * | `getByRole(...)`                     | no  (0)         |
 * | `locator(cssSelector)`               | YES (1)         |
 * | `getByLabel(...)`                    | YES (1)         |
 * | `getByText(...)`                     | YES (1)         |
 * | `getByPlaceholder(...)`              | YES (1)         |
 * | `.filter({ visible: true })`         | no  (0)         |
 *
 * `getByLabel` is the one that matters most here and the one it is easiest to
 * assume safe: this suite reaches nearly every form field through it. That probe
 * is not folklore — journey 50 re-runs it hermetically, so the day a Playwright
 * upgrade changes the answer the suite says which cell moved. The machine-readable
 * half of the table lives in `visible-queries.ts`.
 *
 * ## The boundary: the page, never a Locator
 *
 * {@link visiblePage} scopes the queries hanging off `page`, and deliberately
 * leaves `row.locator(...)` alone. A hidden descendant of a VISIBLE ancestor is
 * hidden by the app's own doing — a collapsed fold, a closed drawer — and a spec
 * asserting about it is asking a legitimate question. Only the page root can
 * reach across into a route that is no longer on screen, so only the page root
 * is scoped.
 *
 * ## Asking about the document on purpose
 *
 * {@link wholeDocument} hands back the unscoped page for the rare assertion whose
 * subject IS the hidden DOM — proving the retention contract itself, or pinning
 * that an element is absent rather than merely invisible.
 *
 * That second case is not hypothetical, and it is the honest cost of scoping the
 * page root: a root query cannot tell a retained route from a fold the app itself
 * closed, so an absence assertion that used to mean «not in the document» now
 * means «not on screen» and would pass for a control that came back INSIDE a
 * closed fold. The absence assertions where that difference is the whole point ask
 * `wholeDocument` explicitly (journeys 16, 40, 43, demo).
 */
import { test as base, type Locator, type Page } from "@playwright/test";

import { seesHiddenDom } from "./visible-queries";

/**
 * Where {@link wholeDocument} finds the real page behind a scoped one.
 *
 * A side table rather than a hidden property on the proxy: a property lookup
 * would have to fall back to the page it was handed when the marker is missing,
 * and «missing» is indistinguishable from «this page was never scoped». That
 * fallback fails OPEN — `wholeDocument` would return a still-scoped page and the
 * assertion built on it would fail as if the app had broken. Here the two cases
 * are distinct and the wrong one is loud.
 */
const UNSCOPED = new WeakMap<Page, Page>();

/**
 * The same page, with every hidden-blind query narrowed to what is on screen.
 *
 * Every method is bound to the REAL page rather than to the proxy. Playwright's
 * `Page` keeps private state, and handing it a proxy as `this` is how a wrapper
 * like this stops being transparent; binding keeps the proxy purely a lens over
 * the query methods.
 */
export function visiblePage(page: Page): Page {
  const scoped = new Proxy(page, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;

      if (typeof property === "string" && seesHiddenDom(property)) {
        return (...args: unknown[]) =>
          (value.apply(target, args) as Locator).filter({ visible: true });
      }
      return value.bind(target);
    },
  });
  UNSCOPED.set(scoped, page);
  return scoped;
}

/** Whether this page came out of {@link visiblePage}. */
export function isVisibilityScoped(page: Page): boolean {
  return UNSCOPED.has(page);
}

/**
 * The unscoped page, for a spec whose subject is the hidden DOM itself.
 *
 * Throws when handed a page that was never scoped, instead of quietly returning
 * it: the caller is about to assert about hidden DOM, and a page that only LOOKS
 * unscoped would answer «not there» for everything hidden — an assertion that
 * passes or fails for a reason nobody wrote down.
 */
export function wholeDocument(page: Page): Page {
  const unscoped = UNSCOPED.get(page);
  if (!unscoped) {
    throw new Error(
      "wholeDocument() was handed a page that is not visibility-scoped. Take " +
        "`test` from ./fixtures (or ./visible-page) so `page` comes from " +
        "visiblePage(); see e2e/visible-page.ts (#1351).",
    );
  }
  return unscoped;
}

/**
 * The visibility scope and NOTHING else, for the journeys that do not take
 * `./fixtures`. There are two, for two different reasons: journey 47 provokes the
 * very browser errors that fixture's gate fails on (a blocked CSP request), and
 * `demo.spec.ts` has never taken it — a standing gap, not a reasoned exemption,
 * and out of scope to close here (it runs its own build + config, so putting it
 * behind the gate is its own change with its own risk).
 *
 * Both still navigate, so both still need the scope, and this way they get it
 * without either copying the proxy or inheriting a gate they are not opting into.
 * Everything else must go through `./fixtures`, which builds on this.
 */
export const visibilityScopedTest = base.extend({
  page: async ({ page }, use) => {
    await use(visiblePage(page));
  },
});
