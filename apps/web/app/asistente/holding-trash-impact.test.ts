import { describe, expect, test } from "vitest";

import { holdingTrashImpact, signedContributionMinor } from "./holding-trash-impact";

describe("signedContributionMinor (#1106)", () => {
  test("a fully-owned asset contributes its whole value", () => {
    expect(signedContributionMinor(2_500_00, 10_000, 1)).toBe(2_500_00);
  });

  test("a partially-owned asset contributes only its share", () => {
    expect(signedContributionMinor(2_000_00, 7_500, 1)).toBe(1_500_00);
  });

  test("a debt contributes a negative, ownership-weighted amount", () => {
    expect(signedContributionMinor(120_000_00, 10_000, -1)).toBe(-120_000_00);
    expect(signedContributionMinor(100_000_00, 5_000, -1)).toBe(-50_000_00);
  });
});

describe("holdingTrashImpact (#1106)", () => {
  const lines = [{ contributionMinor: 2_500_00 }, { contributionMinor: -1_000_00 }];

  test("removal negates the summed contribution", () => {
    expect(holdingTrashImpact(10_000_00, "remove", lines)).toEqual({
      afterMinor: 10_000_00 - 1_500_00,
      beforeMinor: 10_000_00,
      deltaMinor: -1_500_00,
    });
  });

  test("restoration adds the summed contribution", () => {
    expect(holdingTrashImpact(10_000_00, "restore", lines)).toEqual({
      afterMinor: 10_000_00 + 1_500_00,
      beforeMinor: 10_000_00,
      deltaMinor: 1_500_00,
    });
  });

  test("a degraded net-worth read leaves the total unknown but keeps the delta", () => {
    expect(holdingTrashImpact(null, "remove", lines)).toEqual({
      afterMinor: null,
      beforeMinor: null,
      deltaMinor: -1_500_00,
    });
  });

  test("removing a debt (negative contribution) raises net worth", () => {
    expect(
      holdingTrashImpact(5_000_00, "remove", [{ contributionMinor: -3_000_00 }]),
    ).toEqual({
      afterMinor: 8_000_00,
      beforeMinor: 5_000_00,
      deltaMinor: 3_000_00,
    });
  });
});
