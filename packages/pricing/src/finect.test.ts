/**
 * Finect NAV date stamp (issue #1380).
 *
 * The NAV itself comes from the page's JSON-LD offer and is pinned in
 * `providers.test.ts`; what this suite covers is the *date* scraped from the
 * visible label, and the rule that a date the calendar rejects costs the stamp
 * but never the price.
 *
 * Every case is derived from the real captured sheet (see
 * `__fixtures__/finect/README.md`) rather than hand-rolled HTML: the label
 * arrives wrapped in React comments and a `<time>` element, and that wrapping
 * is exactly what Finect changes under us.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PENSION_PLAN_EUR_HTML } from "./__fixtures__/finect";
import { finectProvider } from "./finect";

const CTX = {
  assetId: "asset-1",
  symbol: "N5394-Myinvestor",
  currency: "EUR",
  nowIso: "2026-08-16T00:00:00.000Z",
};

/** The NAV of the captured sheet, EUR-denominated, so no FX leg is involved. */
const QUOTE = { price: "21.64353", currency: "EUR" };

/** The captured sheet with its NAV date swapped for the one under test. */
function withNavDate(date: string): string {
  return PENSION_PLAN_EUR_HTML.replace("13/08/2026", date);
}

function respondWith(html: string): void {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => html,
  } as Response);
}

describe("finectProvider.fetchPrice — NAV date stamp", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("pads a single-digit day and month", async () => {
    respondWith(withNavDate("5/3/2026"));

    await expect(finectProvider.fetchPrice(CTX)).resolves.toEqual({
      ...QUOTE,
      priceDate: "2026-03-05",
    });
  });

  test("keeps a leap day in a leap year", async () => {
    respondWith(withNavDate("29/02/2024"));

    await expect(finectProvider.fetchPrice(CTX)).resolves.toEqual({
      ...QUOTE,
      priceDate: "2024-02-29",
    });
  });

  test("drops a leap day the year does not have, not the price", async () => {
    respondWith(withNavDate("29/02/2026"));

    await expect(finectProvider.fetchPrice(CTX)).resolves.toEqual(QUOTE);
  });

  test("drops a day the month does not have, not the price", async () => {
    respondWith(withNavDate("31/02/2026"));

    await expect(finectProvider.fetchPrice(CTX)).resolves.toEqual(QUOTE);
  });

  test("drops a month outside 1-12, not the price", async () => {
    respondWith(withNavDate("13/25/2026"));

    await expect(finectProvider.fetchPrice(CTX)).resolves.toEqual(QUOTE);
  });

  test("drops a day-zero underflow, not the price", async () => {
    respondWith(withNavDate("00/03/2026"));

    await expect(finectProvider.fetchPrice(CTX)).resolves.toEqual(QUOTE);
  });

  test("quotes the NAV undated when the sheet drops the label", async () => {
    respondWith(PENSION_PLAN_EUR_HTML.replace("Fecha de <!-- -->valor liquidativo:", ""));

    await expect(finectProvider.fetchPrice(CTX)).resolves.toEqual(QUOTE);
  });
});
