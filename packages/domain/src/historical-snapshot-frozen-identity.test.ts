/**
 * Characterization tests for `resolveFrozenIdentity` (#447). The function had no
 * direct coverage; these pin the contemporaneous-capture selection and its exact
 * tie-break, locked when the sort + filter was replaced by a single O(n) pass.
 * The tie-break cases are the ones that would catch a `>=`/`>` slip in the pass.
 */
import { describe, expect, test } from "vitest";

import {
  resolveFrozenIdentity,
  type FrozenIdentityCapture,
  type ResolvedFrozenIdentity,
} from "./historical-snapshot";

/** A capture carrying its tier in `liquidityTier` so tests can assert which one won. */
const cap = (
  dateKey: string,
  liquidityTier: FrozenIdentityCapture["liquidityTier"],
): FrozenIdentityCapture => ({
  dateKey,
  liquidityTier,
  countsAsHousing: false,
  securesHousing: false,
});

const LIVE: ResolvedFrozenIdentity = {
  liquidityTier: "illiquid",
  countsAsHousing: false,
  securesHousing: false,
};

describe("resolveFrozenIdentity (frozen-capture path)", () => {
  test("picks the latest capture on-or-before the target", () => {
    const result = resolveFrozenIdentity({
      existingRow: undefined,
      frozenIdentity: [
        cap("2024-01-01", "cash"),
        cap("2024-03-01", "market"),
        cap("2024-06-01", "term-locked"),
      ],
      targetDate: "2024-04-15",
      live: LIVE,
    });
    expect(result.liquidityTier).toBe("market"); // 2024-03-01 is the latest ≤ target
  });

  test("falls back to the earliest capture when none is on-or-before the target", () => {
    const result = resolveFrozenIdentity({
      existingRow: undefined,
      frozenIdentity: [cap("2024-06-01", "term-locked"), cap("2024-03-01", "market")],
      targetDate: "2024-01-01",
      live: LIVE,
    });
    expect(result.liquidityTier).toBe("market"); // 2024-03-01 is the earliest overall
  });

  test("on a tie at the max date ≤ target, keeps the LAST capture in input order", () => {
    const result = resolveFrozenIdentity({
      existingRow: undefined,
      frozenIdentity: [cap("2024-03-01", "market"), cap("2024-03-01", "term-locked")],
      targetDate: "2024-05-01",
      live: LIVE,
    });
    expect(result.liquidityTier).toBe("term-locked"); // last among equal-date captures
  });

  test("on a tie at the earliest date (none ≤ target), keeps the FIRST in input order", () => {
    const result = resolveFrozenIdentity({
      existingRow: undefined,
      frozenIdentity: [cap("2024-03-01", "market"), cap("2024-03-01", "term-locked")],
      targetDate: "2024-01-01",
      live: LIVE,
    });
    expect(result.liquidityTier).toBe("market"); // first among equal-date captures
  });

  test("returns the live identity when there are no captures", () => {
    const result = resolveFrozenIdentity({
      existingRow: undefined,
      frozenIdentity: [],
      targetDate: "2024-01-01",
      live: LIVE,
    });
    expect(result).toEqual(LIVE);
  });
});
