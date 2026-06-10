/**
 * Shared e2e test base: browser errors fail the journey.
 *
 * React reports hydration mismatches and rendering warnings through the
 * browser's error channels (uncaught page errors and console.error), so any
 * journey that triggers one — like the <title> array-children hydration bug
 * on the home — fails instead of scrolling by in the dev server logs.
 * Every spec must import { test, expect } from "./fixtures", never from
 * "@playwright/test" directly.
 */
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    const browserErrors: string[] = [];

    page.on("pageerror", (error) => {
      browserErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(`console.error: ${message.text()}`);
      }
    });

    await use(page);

    expect(
      browserErrors,
      "the browser reported errors during this journey (hydration mismatches and React warnings are treated as failures)",
    ).toEqual([]);
  },
});

export { expect };
