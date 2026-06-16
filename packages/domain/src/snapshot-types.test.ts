/**
 * Tests for framed snapshot deltas (#244).
 *
 * deriveFramedSnapshotDeltas turns the raw SnapshotDeltas (the snapshot plus its
 * previous and previous-monthly-close references) into the two headline change
 * chips in the ACTIVE framing — the figure math the dashboard renders. Pure: it
 * reads only the snapshots already carried by SnapshotDeltas and the framing.
 */
import { describe, expect, test } from "vitest";

import type { NetWorthSnapshot, SnapshotDeltas } from "./snapshot-types";
import { deriveFramedSnapshotDeltas } from "./snapshot-types";

function snapshot(id: string, totalMinor: number, liquidMinor: number): NetWorthSnapshot {
  return {
    capturedAt: `2026-06-10T10:00:00.000Z`,
    dateKey: "2026-06-10",
    debts: { amountMinor: 0, currency: "EUR" },
    grossAssets: { amountMinor: totalMinor, currency: "EUR" },
    housingEquity: { amountMinor: 0, currency: "EUR" },
    id,
    isMonthlyClose: false,
    liquidNetWorth: { amountMinor: liquidMinor, currency: "EUR" },
    monthKey: "2026-06",
    scopeId: "household",
    scopeLabel: "Hogar",
    totalNetWorth: { amountMinor: totalMinor, currency: "EUR" },
    warnings: [],
  };
}

describe("deriveFramedSnapshotDeltas", () => {
  test("total framing: change and pct vs previous and vs monthly close", () => {
    const current = snapshot("now", 110_000_00, 60_000_00);
    const previous = snapshot("prev", 100_000_00, 50_000_00);
    const monthlyClose = snapshot("close", 80_000_00, 40_000_00);
    const deltas: SnapshotDeltas = {
      snapshot: current,
      previousSnapshot: previous,
      previousMonthlyClose: monthlyClose,
    };

    const framed = deriveFramedSnapshotDeltas(deltas, "total");

    expect(framed.sincePrevious).toEqual({
      change: { amountMinor: 10_000_00, currency: "EUR" },
      pct: 10,
    });
    expect(framed.sinceMonthlyClose).toEqual({
      change: { amountMinor: 30_000_00, currency: "EUR" },
      pct: 37.5,
    });
  });

  test("liquid framing: figures track the liquid net worth, not the total", () => {
    const current = snapshot("now", 110_000_00, 60_000_00);
    const previous = snapshot("prev", 100_000_00, 50_000_00);
    const monthlyClose = snapshot("close", 80_000_00, 40_000_00);
    const deltas: SnapshotDeltas = {
      snapshot: current,
      previousSnapshot: previous,
      previousMonthlyClose: monthlyClose,
    };

    const framed = deriveFramedSnapshotDeltas(deltas, "liquid");

    expect(framed.sincePrevious).toEqual({
      change: { amountMinor: 10_000_00, currency: "EUR" },
      pct: 20,
    });
    expect(framed.sinceMonthlyClose).toEqual({
      change: { amountMinor: 20_000_00, currency: "EUR" },
      pct: 50,
    });
  });

  test("missing base snapshot → that chip is null", () => {
    const current = snapshot("now", 110_000_00, 60_000_00);
    const deltas: SnapshotDeltas = { snapshot: current };

    const framed = deriveFramedSnapshotDeltas(deltas, "total");

    expect(framed.sincePrevious).toBeNull();
    expect(framed.sinceMonthlyClose).toBeNull();
  });

  test("zero base value → pct is null (no divide-by-zero), change still computed", () => {
    const current = snapshot("now", 110_000_00, 60_000_00);
    const previous = snapshot("prev", 0, 0);
    const deltas: SnapshotDeltas = {
      snapshot: current,
      previousSnapshot: previous,
    };

    const framed = deriveFramedSnapshotDeltas(deltas, "total");

    expect(framed.sincePrevious).toEqual({
      change: { amountMinor: 110_000_00, currency: "EUR" },
      pct: null,
    });
  });
});
