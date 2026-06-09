import { describe, expect, test } from "vitest";

import { allocateScopedHolding } from "./scope-allocation";

// ── allocateScopedHolding ─────────────────────────────────────────────────────
// Behaviour contract:
//  • returns ownedMinor = allocateByBps(amountMinor, scopeTotalBps)
//  • returns totalShareBps = sum of shareBps for members in scopeMemberIds
//  • members not in scope are excluded from both
//  • holding with 0% scope share → ownedMinor 0, totalShareBps 0
//  • rounding: allocateByBps half-up floor-division, same as money.ts

describe("allocateScopedHolding", () => {
  const ANA = "member_ana";
  const JOSE = "member_jose";
  const LUZ = "member_luz";

  test("returns full amount and 10_000 bps when all owners are in scope (household)", () => {
    const result = allocateScopedHolding(100_000, {
      ownership: [
        { memberId: ANA, shareBps: 5_000 },
        { memberId: JOSE, shareBps: 5_000 },
      ],
      scopeMemberIds: new Set([ANA, JOSE]),
    });

    expect(result.ownedMinor).toBe(100_000);
    expect(result.totalShareBps).toBe(10_000);
  });

  test("returns half amount and 5_000 bps for a single-member scope", () => {
    const result = allocateScopedHolding(100_000, {
      ownership: [
        { memberId: ANA, shareBps: 5_000 },
        { memberId: JOSE, shareBps: 5_000 },
      ],
      scopeMemberIds: new Set([ANA]),
    });

    expect(result.ownedMinor).toBe(50_000);
    expect(result.totalShareBps).toBe(5_000);
  });

  test("excludes members not in scope", () => {
    const result = allocateScopedHolding(60_000, {
      ownership: [
        { memberId: ANA, shareBps: 3_000 },
        { memberId: JOSE, shareBps: 4_000 },
        { memberId: LUZ, shareBps: 3_000 },
      ],
      scopeMemberIds: new Set([ANA, LUZ]),
    });

    // Ana 30% + Luz 30% = 60% of 60_000 = 36_000
    expect(result.ownedMinor).toBe(36_000);
    expect(result.totalShareBps).toBe(6_000);
  });

  test("returns zeros when scope has no ownership stake in this holding", () => {
    const result = allocateScopedHolding(100_000, {
      ownership: [{ memberId: ANA, shareBps: 10_000 }],
      scopeMemberIds: new Set([JOSE]),
    });

    expect(result.ownedMinor).toBe(0);
    expect(result.totalShareBps).toBe(0);
  });

  test("rounds at basis-point edges using half-up floor division (positive amount)", () => {
    // 3 bps of 100 = 0.03 → rounds to 0 (floor division: 300 + 5000 = 5300, floor(5300/10000) = 0)
    const result1 = allocateScopedHolding(100, {
      ownership: [{ memberId: ANA, shareBps: 3 }],
      scopeMemberIds: new Set([ANA]),
    });
    expect(result1.ownedMinor).toBe(0);

    // 5000 bps of 1 = 0.5 → rounds to 1 (half-up: 5000 + 5000 = 10000, floor(10000/10000) = 1)
    const result2 = allocateScopedHolding(1, {
      ownership: [{ memberId: ANA, shareBps: 5_000 }],
      scopeMemberIds: new Set([ANA]),
    });
    expect(result2.ownedMinor).toBe(1);

    // 4999 bps of 1 = 0.4999 → rounds to 0 (4999 + 5000 = 9999, floor(9999/10000) = 0)
    const result3 = allocateScopedHolding(1, {
      ownership: [{ memberId: ANA, shareBps: 4_999 }],
      scopeMemberIds: new Set([ANA]),
    });
    expect(result3.ownedMinor).toBe(0);
  });

  test("handles negative amounts (debt balances) correctly", () => {
    const result = allocateScopedHolding(-20_000, {
      ownership: [
        { memberId: ANA, shareBps: 5_000 },
        { memberId: JOSE, shareBps: 5_000 },
      ],
      scopeMemberIds: new Set([ANA]),
    });

    expect(result.ownedMinor).toBe(-10_000);
    expect(result.totalShareBps).toBe(5_000);
  });

  test("full 10_000 bps share always round-trips the whole amount", () => {
    const amounts = [0, 1, 99, 100, 10_001, -500, -1];

    for (const amount of amounts) {
      const result = allocateScopedHolding(amount, {
        ownership: [{ memberId: ANA, shareBps: 10_000 }],
        scopeMemberIds: new Set([ANA]),
      });
      expect(result.ownedMinor).toBe(amount);
      expect(result.totalShareBps).toBe(10_000);
    }
  });
});
