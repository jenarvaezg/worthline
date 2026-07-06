import { describe, expect, it } from "vitest";

import type { DatedAmount } from "./payouts";
import { scopePassiveIncome } from "./objetivos-passive-income";
import type { OwnershipShare } from "./workspace-types";

const FULL: OwnershipShare[] = [{ memberId: "m_jose", shareBps: 10_000 }];
const HALF: OwnershipShare[] = [
  { memberId: "m_jose", shareBps: 5_000 },
  { memberId: "m_ana", shareBps: 5_000 },
];

function lens(
  payoutsByHolding: Map<string, DatedAmount[]>,
  holdings: { id: string; ownership: OwnershipShare[] }[],
  overrides: Partial<Parameters<typeof scopePassiveIncome>[0]> = {},
) {
  return scopePassiveIncome({
    payoutsByHolding,
    holdings,
    scopeMemberIds: new Set(["m_jose"]),
    monthlySpendingMinor: null,
    todayISO: "2026-07-06",
    ...overrides,
  });
}

describe("scopePassiveIncome", () => {
  it("sums a fully-owned holding's trailing payouts (tracer)", () => {
    const result = lens(
      new Map([["h_flat", [{ dateISO: "2026-03-01", amountMinor: 90_000 }]]]),
      [{ id: "h_flat", ownership: FULL }],
    );

    expect(result.totalMinor).toBe(90_000);
    expect(result.count).toBe(1);
    expect(result.hasPayouts).toBe(true);
  });

  it("weights each payout by the scope's ownership share", () => {
    const result = lens(
      new Map([["h_flat", [{ dateISO: "2026-03-01", amountMinor: 100_000 }]]]),
      [{ id: "h_flat", ownership: HALF }],
    );

    // Jose owns 50% → half the payout attributes to his scope.
    expect(result.totalMinor).toBe(50_000);
    expect(result.count).toBe(1);
  });

  it("excludes holdings the scope does not own at all", () => {
    const result = lens(
      new Map([["h_ana", [{ dateISO: "2026-03-01", amountMinor: 100_000 }]]]),
      [{ id: "h_ana", ownership: [{ memberId: "m_ana", shareBps: 10_000 }] }],
    );

    expect(result.totalMinor).toBe(0);
    expect(result.count).toBe(0);
    expect(result.hasPayouts).toBe(false);
  });

  it("drops payouts older than the trailing window without annualizing", () => {
    const result = lens(
      new Map([
        [
          "h_flat",
          [
            { dateISO: "2025-01-01", amountMinor: 50_000 }, // > 12m ago → out
            { dateISO: "2026-05-01", amountMinor: 30_000 }, // in window
          ],
        ],
      ]),
      [{ id: "h_flat", ownership: FULL }],
    );

    expect(result.totalMinor).toBe(30_000);
    expect(result.count).toBe(1);
    expect(result.windowStartISO).toBe("2025-07-06");
    expect(result.windowEndISO).toBe("2026-07-06");
    // a payout still on record but outside the window keeps the surface non-empty
    expect(result.hasPayouts).toBe(true);
  });

  it("reports coverage vs declared annual spending when spending is known", () => {
    const result = lens(
      new Map([["h_flat", [{ dateISO: "2026-03-01", amountMinor: 600_000 }]]]),
      [{ id: "h_flat", ownership: FULL }],
      { monthlySpendingMinor: 100_000 },
    );

    // 600.000 trailing / (100.000 * 12 = 1.200.000) declared = 0,5
    expect(result.annualSpendingMinor).toBe(1_200_000);
    expect(result.coverageRatio).toBeCloseTo(0.5);
  });

  it("omits coverage when spending is unknown or zero rather than inventing it", () => {
    const noSpend = lens(
      new Map([["h_flat", [{ dateISO: "2026-03-01", amountMinor: 600_000 }]]]),
      [{ id: "h_flat", ownership: FULL }],
      { monthlySpendingMinor: null },
    );
    expect(noSpend.annualSpendingMinor).toBeNull();
    expect(noSpend.coverageRatio).toBeNull();

    const zeroSpend = lens(
      new Map([["h_flat", [{ dateISO: "2026-03-01", amountMinor: 600_000 }]]]),
      [{ id: "h_flat", ownership: FULL }],
      { monthlySpendingMinor: 0 },
    );
    expect(zeroSpend.annualSpendingMinor).toBeNull();
    expect(zeroSpend.coverageRatio).toBeNull();
  });

  it("is empty when the scope has recorded no payouts", () => {
    const result = lens(new Map(), [{ id: "h_flat", ownership: FULL }]);

    expect(result.totalMinor).toBe(0);
    expect(result.count).toBe(0);
    expect(result.coverageRatio).toBeNull();
    expect(result.hasPayouts).toBe(false);
  });
});
