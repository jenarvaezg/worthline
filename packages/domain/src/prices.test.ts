import { describe, expect, test } from "vitest";

import { getPriceFreshness } from "./prices";

describe("getPriceFreshness", () => {
  test("manual source always returns 'manual' regardless of age", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2025-01-01", freshnessState: "manual", source: "manual" },
        "2026-01-01",
      ),
    ).toBe("manual");
  });

  test("stooq price fetched within TTL returns 'fresh'", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2026-06-08T10:00:00Z", freshnessState: "fresh", source: "stooq" },
        "2026-06-08T22:00:00Z",
      ),
    ).toBe("fresh");
  });

  test("stooq price older than 1 day returns 'stale'", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2026-06-07T10:00:00Z", freshnessState: "fresh", source: "stooq" },
        "2026-06-09T10:00:00Z",
      ),
    ).toBe("stale");
  });

  test("failed state returns 'failed' regardless of source or age", () => {
    expect(
      getPriceFreshness(
        { fetchedAt: "2026-06-01", freshnessState: "failed", source: "stooq" },
        "2026-06-09",
      ),
    ).toBe("failed");
  });
});
