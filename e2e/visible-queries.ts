/**
 * Which Playwright page queries see hidden DOM — the measured table behind the
 * suite's visibility scope (#1351).
 *
 * Split out from `visible-page.ts` so it can be read by something that is not a
 * Playwright runner: the vitest guardian (`tests/e2e-page-scope-guardian.test.ts`)
 * both pins this table and uses it to scan the specs, and importing the proxy
 * module would drag the Playwright test runner in with it. No imports of its own,
 * on purpose.
 *
 * See `visible-page.ts` for the why (Next keeps up to three routes in the
 * document since #1229) and journey 50 for the probe that measures the table in a
 * real browser — it iterates THIS list, so a method added here is a method
 * measured, never one taken on faith.
 */

/**
 * The page-scoped query methods that return hidden nodes, so the suite narrows
 * them. `getByRole` is absent because it already filters on its own.
 *
 * Every entry is measured, including the three no spec uses yet (`getByTitle`,
 * `getByAltText`, `getByTestId`): journey 50 walks this list and its target table
 * is exhaustive over it, so adding a method here does not compile until it has a
 * probe. Listing them ahead of a caller is cheap; discovering the day one appears
 * that it was never narrowed is not.
 */
export const QUERIES_THAT_SEE_HIDDEN_DOM = [
  "locator",
  "getByLabel",
  "getByText",
  "getByPlaceholder",
  "getByTitle",
  "getByAltText",
  "getByTestId",
] as const;

/** Whether a page method needs narrowing to what is on screen. */
export function seesHiddenDom(method: string): boolean {
  return (QUERIES_THAT_SEE_HIDDEN_DOM as readonly string[]).includes(method);
}
