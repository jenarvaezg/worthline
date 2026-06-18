/**
 * Unit tests for the pure Binance TILE helpers (PRD #245/#248, ADR 0021): the
 * cross-rung value aggregation + the re-exported generic helpers. Credential
 * shaping/read-back moved into the Binance ADAPTER (#322, ADR 0027) — those tests
 * live in packages/pricing/src/adapters/binance.test.ts now. No store, no network.
 */

import { describe, expect, test } from "vitest";

import {
  aggregateSourceValueMinor,
  formatLastSync,
  resolveConnectingOwnership,
} from "./binance-helpers";

function asset(id: string, amountMinor: number) {
  return { id, currentValue: { amountMinor } };
}

describe("re-exported generic helpers", () => {
  test("resolveConnectingOwnership is the shared numista helper", () => {
    expect(resolveConnectingOwnership([{ id: "mJ", name: "Jose" }], undefined)).toEqual([
      { memberId: "mJ", shareBps: 10_000 },
    ]);
  });

  test("formatLastSync is the shared numista helper", () => {
    expect(formatLastSync(null)).toBe("Nunca");
    expect(formatLastSync("2026-06-16T11:20:00.000Z")).toMatch(/2026/);
  });
});

describe("aggregateSourceValueMinor", () => {
  test("a single market asset returns its value", () => {
    const ids = new Set(["market"]);
    expect(aggregateSourceValueMinor([asset("market", 2_500_000)], ids)).toBe(2_500_000);
  });

  test("a market + term-locked pair returns the summed value (#248)", () => {
    const ids = new Set(["market", "locked"]);
    expect(
      aggregateSourceValueMinor(
        [asset("market", 2_500_000), asset("locked", 600_000)],
        ids,
      ),
    ).toBe(3_100_000);
  });

  test("assets not in the source's set are excluded", () => {
    const ids = new Set(["market"]);
    expect(
      aggregateSourceValueMinor(
        [asset("market", 2_500_000), asset("unrelated", 9_999_999)],
        ids,
      ),
    ).toBe(2_500_000);
  });

  test("an empty set sums to zero", () => {
    expect(aggregateSourceValueMinor([asset("market", 2_500_000)], new Set())).toBe(0);
  });
});
