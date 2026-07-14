/**
 * Tests for the home freshness derivation (#896, P0-1 front of #783).
 *
 * Pure product-language logic: a single "última actualización" timestamp + now →
 * an always-visible calm stamp and a `stale` flag that trips only when the most
 * recent data outran the automatic-update window (cron cadence + margin). No
 * technical wording, no dates leaking here — the phrasing is asserted in es-ES.
 */

import { describe, expect, test } from "vitest";

import {
  deriveFreshness,
  FRESHNESS_STALE_THRESHOLD_HOURS,
  latestFetchedAt,
} from "./freshness";

const NOW = "2026-07-14T12:00:00.000Z";

/** `NOW` minus `hours` (fractional allowed), as an ISO string. */
function hoursAgo(hours: number): string {
  return new Date(new Date(NOW).getTime() - hours * 3_600_000).toISOString();
}

describe("deriveFreshness", () => {
  test("no timestamp → no stamp, never stale", () => {
    expect(deriveFreshness(null, NOW)).toEqual({ stampLabel: null, stale: false });
  });

  test("under an hour reads as a calm moment, never stale", () => {
    expect(deriveFreshness(hoursAgo(0.5), NOW)).toEqual({
      stampLabel: "Actualizado hace un momento",
      stale: false,
    });
  });

  test("hours within the day read in whole hours", () => {
    expect(deriveFreshness(hoursAgo(1), NOW).stampLabel).toBe("Actualizado hace 1 h");
    expect(deriveFreshness(hoursAgo(15), NOW).stampLabel).toBe("Actualizado hace 15 h");
  });

  test("a day back reads as 'ayer'", () => {
    expect(deriveFreshness(hoursAgo(30), NOW).stampLabel).toBe("Actualizado ayer");
  });

  test("older reads in whole days", () => {
    expect(deriveFreshness(hoursAgo(24 * 3), NOW).stampLabel).toBe(
      "Actualizado hace 3 días",
    );
  });

  test("within the automatic-update window is not stale", () => {
    // Just under the threshold — a normal gap between the two daily passes.
    expect(
      deriveFreshness(hoursAgo(FRESHNESS_STALE_THRESHOLD_HOURS - 0.5), NOW).stale,
    ).toBe(false);
  });

  test("past the window trips the soft alert", () => {
    // At/over the threshold a pass was missed → the gentle "we couldn't update".
    expect(deriveFreshness(hoursAgo(FRESHNESS_STALE_THRESHOLD_HOURS), NOW).stale).toBe(
      true,
    );
    expect(
      deriveFreshness(hoursAgo(FRESHNESS_STALE_THRESHOLD_HOURS + 10), NOW).stale,
    ).toBe(true);
  });

  test("a stale stamp still carries the calm phrasing", () => {
    // The stamp is ALWAYS shown; the alert is the additive signal (#896).
    expect(deriveFreshness(hoursAgo(20), NOW)).toEqual({
      stampLabel: "Actualizado hace 20 h",
      stale: true,
    });
  });

  test("a future timestamp (clock skew) clamps to a moment, never stale", () => {
    expect(deriveFreshness(hoursAgo(-2), NOW)).toEqual({
      stampLabel: "Actualizado hace un momento",
      stale: false,
    });
  });

  test("the threshold sits above the 12 h window with margin (afinable)", () => {
    // Guard the tuning intent from #785/#788: > the ~12 h cron gap, < a full day.
    expect(FRESHNESS_STALE_THRESHOLD_HOURS).toBeGreaterThan(12);
    expect(FRESHNESS_STALE_THRESHOLD_HOURS).toBeLessThan(24);
  });
});

describe("latestFetchedAt", () => {
  test("null on an empty cache (a purely-manual portfolio has no stamp)", () => {
    expect(latestFetchedAt([])).toBeNull();
  });

  test("returns the most recent SUCCESSFUL fetch instant regardless of order", () => {
    expect(
      latestFetchedAt([
        { fetchedAt: "2026-07-14T09:00:00.000Z", freshnessState: "fresh" },
        { fetchedAt: "2026-07-14T11:30:00.000Z", freshnessState: "fresh" },
        { fetchedAt: "2026-07-13T21:00:00.000Z", freshnessState: "fresh" },
      ]),
    ).toBe("2026-07-14T11:30:00.000Z");
  });

  test("ignores non-fresh rows so a bumped-but-failed fetch can't overstate freshness", () => {
    // A failed/stale fetch bumps fetchedAt to now while keeping the old price; a
    // manual row is not an automatic update. Only the older FRESH row counts, so
    // the stamp ages honestly toward the alert.
    expect(
      latestFetchedAt([
        { fetchedAt: "2026-07-14T11:59:00.000Z", freshnessState: "failed" },
        { fetchedAt: "2026-07-14T11:58:00.000Z", freshnessState: "stale" },
        { fetchedAt: "2026-07-14T11:57:00.000Z", freshnessState: "manual" },
        { fetchedAt: "2026-07-13T20:00:00.000Z", freshnessState: "fresh" },
      ]),
    ).toBe("2026-07-13T20:00:00.000Z");
  });

  test("null when nothing succeeded (all rows stale/failed/manual)", () => {
    expect(
      latestFetchedAt([
        { fetchedAt: "2026-07-14T11:59:00.000Z", freshnessState: "failed" },
        { fetchedAt: "2026-07-14T11:58:00.000Z", freshnessState: "manual" },
      ]),
    ).toBeNull();
  });

  test("feeds deriveFreshness end to end", () => {
    // Cache last fetched 20 h before NOW → a missed pass → stale, calm phrasing.
    const view = deriveFreshness(
      latestFetchedAt([{ fetchedAt: hoursAgo(20), freshnessState: "fresh" }]),
      NOW,
    );
    expect(view).toEqual({ stampLabel: "Actualizado hace 20 h", stale: true });
  });
});
