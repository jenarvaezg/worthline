/**
 * E2E page-scope guardian (#1351): a journey that queries the page with a
 * hidden-blind method must get its `page` from a visibility-scoped base.
 *
 * Since #1229 Next keeps the route you navigate away from in the document, hidden
 * with `<Activity mode="hidden">`. Only `getByRole` filters that out on its own —
 * `locator`, `getByLabel`, `getByText` and friends all return the hidden node
 * (measured; see `e2e/visible-page.ts` and journey 50). So a spec that reaches for
 * one of them on a RAW Playwright page can silently answer about the page the
 * person has already left, which is the shape #1351 was filed for.
 *
 * `e2e/fixtures.ts` and `e2e/visible-page.ts` both hand out a scoped page, so the
 * rule is simply: take `test` from one of them. This guardian is what keeps the
 * next journey from being written against `@playwright/test` directly and quietly
 * losing the scope — the failure it prevents is intermittent and reads like an app
 * bug, so it must be caught at authoring time rather than in CI.
 *
 * TWO KNOWN GAPS, named rather than papered over, because a guardian that hides
 * what it does not cover is worse than one that says so:
 *
 * 1. A journey may still take `test` from Playwright directly as long as it never
 *    uses a hidden-blind page query (`34-pwa`, `35-home-fire-glance`,
 *    `route-migration-auth` do). Those keep working and become offenders the moment
 *    they add one, which is exactly when it matters.
 * 2. The scan is textual, so it sees `page.locator(` and not an aliased page
 *    (`const p = page; p.locator(…)`) or a page handed to a helper that then
 *    queries it. Closing that needs a real parse; the shapes it misses are not
 *    ones this suite writes, and the day one appears the fix is here.
 *
 * Lives in the `@worthline/tests` workspace because it spans two zones — it reads
 * `e2e/` and reuses the web app's guardian walk — and that workspace is the one
 * whose aliases reach both.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUERIES_THAT_SEE_HIDDEN_DOM, seesHiddenDom } from "@e2e/visible-queries";
import { stripComments, walkSourceFiles } from "@web/guardian-walk";
import { describe, expect, test } from "vitest";

/** The suite lives at the repo root, one level above `tests/`. */
const E2E_DIR = join(import.meta.dirname, "../e2e");

/** The two bases that hand out a visibility-scoped page. */
const SCOPED_BASE =
  /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*"\.\/(fixtures|visible-page)"/;

/** Which hidden-blind page queries this source uses, if any. */
export function hiddenBlindPageQueries(source: string): string[] {
  const text = stripComments(source);
  return QUERIES_THAT_SEE_HIDDEN_DOM.filter((method) => text.includes(`page.${method}(`));
}

/** Whether this source takes `test` from a visibility-scoped base. */
export function takesScopedTest(source: string): boolean {
  return SCOPED_BASE.test(stripComments(source));
}

/**
 * Every journey in the suite, via the shared guardian walk — recursive and with
 * the same skip rules every other guardian uses, rather than a private
 * `readdirSync` that would stop guarding the day a spec moves into a subfolder
 * (the exact divergence `guardian-walk.ts` exists to prevent).
 */
function readSpecs(): Array<{ fileName: string; source: string }> {
  return walkSourceFiles(E2E_DIR)
    .filter((filePath) => filePath.endsWith(".spec.ts"))
    .map((filePath) => ({
      fileName: filePath.slice(E2E_DIR.length + 1),
      source: readFileSync(filePath, "utf8"),
    }));
}

describe("e2e page-scope guardian (#1351)", () => {
  test("the suite has specs to check (the walk itself is not silently empty)", () => {
    expect(readSpecs().length).toBeGreaterThan(40);
  });

  test("every journey using a hidden-blind page query takes a scoped `test`", () => {
    const offenders = readSpecs()
      .map(({ fileName, source }) => ({
        fileName,
        queries: hiddenBlindPageQueries(source),
        scoped: takesScopedTest(source),
      }))
      .filter(({ queries, scoped }) => queries.length > 0 && !scoped)
      .map(({ fileName, queries }) => `${fileName}: page.${queries.join(", page.")}`);

    expect(
      offenders,
      'import `test` from "./fixtures" (or "./visible-page" when the journey must ' +
        "opt out of the browser-error gate): a raw Playwright page sees the DOM of " +
        "the route you navigated away from, which Next keeps mounted and hidden " +
        "since #1229 (#1351)",
    ).toEqual([]);
  });

  describe("the measured table", () => {
    test("getByRole is NOT narrowed — it already filters by visibility", () => {
      expect(seesHiddenDom("getByRole")).toBe(false);
      // Journey 50 is what proves this in a real browser; if that probe ever goes
      // red, this list is what has to change with it.
      expect(QUERIES_THAT_SEE_HIDDEN_DOM).not.toContain("getByRole");
    });

    test("the queries a form-heavy suite actually leans on are narrowed", () => {
      for (const method of ["locator", "getByLabel", "getByText", "getByPlaceholder"]) {
        expect(seesHiddenDom(method), `${method} must be narrowed`).toBe(true);
      }
    });

    test("an unrelated page method is left alone", () => {
      for (const method of ["goto", "waitForURL", "evaluate", "keyboard"]) {
        expect(seesHiddenDom(method)).toBe(false);
      }
    });
  });

  describe("the scan itself", () => {
    test("sees a hidden-blind query and names it", () => {
      expect(hiddenBlindPageQueries(`await page.locator(".x").click();`)).toEqual([
        "locator",
      ]);
      expect(
        hiddenBlindPageQueries(`page.getByLabel("Unidades"); page.getByText("hi");`),
      ).toEqual(["getByLabel", "getByText"]);
    });

    test("ignores a query named in prose", () => {
      expect(
        hiddenBlindPageQueries(`/** Never use page.locator( here. */\nconst a = 1;`),
      ).toEqual([]);
    });

    test("does not mistake a scoped locator for a page-scoped one", () => {
      expect(hiddenBlindPageQueries(`row.locator("td").first();`)).toEqual([]);
    });

    test("recognises both scoped bases, aliased or not", () => {
      expect(takesScopedTest(`import { expect, test } from "./fixtures";`)).toBe(true);
      expect(
        takesScopedTest(`import { visibilityScopedTest as test } from "./visible-page";`),
      ).toBe(true);
      expect(takesScopedTest(`import { expect, test } from "@playwright/test";`)).toBe(
        false,
      );
      // A type-only Page import from Playwright is not a base and must not count.
      expect(takesScopedTest(`import type { Page } from "@playwright/test";`)).toBe(
        false,
      );
    });
  });
});
