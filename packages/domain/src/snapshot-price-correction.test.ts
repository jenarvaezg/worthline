import { describe, expect, test } from "vitest";

import {
  planSnapshotPriceCorrection,
  snapshotPriceCorrectionErrorMessage,
} from "./snapshot-price-correction";

const OP = {
  assetId: "etf",
  currency: "EUR" as const,
  executedAt: "2026-07-01",
  feesMinor: 0,
  id: "op1",
  kind: "buy" as const,
  pricePerUnit: "10",
  units: "5",
};

const TODAY = "2026-07-11";

describe("planSnapshotPriceCorrection (#926)", () => {
  test("plans an update when a snapshot exists on the date", () => {
    const result = planSnapshotPriceCorrection({
      dateKey: "2026-07-09",
      existingSnapshotDates: new Set(["2026-07-09"]),
      operations: [OP],
      today: TODAY,
      unitPriceRaw: "12.5",
    });

    expect(result).toEqual({
      ok: true,
      point: {
        action: "update",
        dateKey: "2026-07-09",
        unitPriceDecimal: "12.5",
        units: "5",
        valueMinor: 6250,
      },
    });
  });

  test("plans a create when no snapshot exists on the date", () => {
    const result = planSnapshotPriceCorrection({
      dateKey: "2026-07-09",
      existingSnapshotDates: new Set(["2026-07-01"]),
      operations: [OP],
      today: TODAY,
      unitPriceRaw: "12.5",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.point.action).toBe("create");
    }
  });

  test("rejects dates without an open position", () => {
    const result = planSnapshotPriceCorrection({
      dateKey: "2026-06-01",
      existingSnapshotDates: new Set(),
      operations: [OP],
      today: TODAY,
      unitPriceRaw: "12.5",
    });

    expect(result).toEqual({ ok: false, reason: "no_position" });
    expect(snapshotPriceCorrectionErrorMessage("no_position")).toContain("posición");
  });

  test("rejects invalid input", () => {
    expect(
      planSnapshotPriceCorrection({
        dateKey: "bad",
        existingSnapshotDates: new Set(),
        operations: [OP],
        today: TODAY,
        unitPriceRaw: "12.5",
      }),
    ).toEqual({ ok: false, reason: "invalid_date" });

    expect(
      planSnapshotPriceCorrection({
        dateKey: "2026-07-09",
        existingSnapshotDates: new Set(),
        operations: [OP],
        today: TODAY,
        unitPriceRaw: "-1",
      }),
    ).toEqual({ ok: false, reason: "invalid_price" });
  });

  test("rejects a future date server-side (the form's max attribute is advisory only)", () => {
    expect(
      planSnapshotPriceCorrection({
        dateKey: "2026-07-12",
        existingSnapshotDates: new Set(),
        operations: [OP],
        today: TODAY,
        unitPriceRaw: "12.5",
      }),
    ).toEqual({ ok: false, reason: "future_date" });
    expect(snapshotPriceCorrectionErrorMessage("future_date")).toContain("futura");

    // Today itself is a valid correction target.
    const todayResult = planSnapshotPriceCorrection({
      dateKey: TODAY,
      existingSnapshotDates: new Set(),
      operations: [OP],
      today: TODAY,
      unitPriceRaw: "12.5",
    });
    expect(todayResult.ok).toBe(true);
  });
});
