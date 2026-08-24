import { describe, expect, test } from "vitest";

import {
  assertManagedPortfolioInput,
  computeManagedPortfolioFigures,
  managedPortfolioMemberRoles,
  undetailedMemberName,
  undetailedRemainderMinor,
} from "./managed-portfolio";

describe("assertManagedPortfolioInput", () => {
  test("accepts a plain name", () => {
    expect(() =>
      assertManagedPortfolioInput({ name: "Cartera Indexada Metal" }),
    ).not.toThrow();
  });

  test("rejects a blank name — the portfolio needs something to be called", () => {
    expect(() => assertManagedPortfolioInput({ name: "   " })).toThrow(
      "La cartera necesita un nombre.",
    );
  });
});

describe("computeManagedPortfolioFigures", () => {
  test("sums the members and derives each one's weight", () => {
    const figures = computeManagedPortfolioFigures({
      members: [
        { holdingId: "f1", valueMinor: 600_00 },
        { holdingId: "cash", valueMinor: 7_34 },
        { holdingId: "f2", valueMinor: 300_00 },
      ],
    });

    expect(figures.totalMinor).toBe(907_34);
    expect(figures.slices).toHaveLength(3);
    const byId = new Map(figures.slices.map((slice) => [slice.holdingId, slice]));
    expect(byId.get("f1")?.weight).toBeCloseTo(600_00 / 907_34, 10);
    expect(byId.get("f2")?.weight).toBeCloseTo(300_00 / 907_34, 10);
    expect(byId.get("cash")?.weight).toBeCloseTo(7_34 / 907_34, 10);
  });

  test("orders the composition by value, largest first (ties by id)", () => {
    const figures = computeManagedPortfolioFigures({
      members: [
        { holdingId: "b", valueMinor: 100_00 },
        { holdingId: "d", valueMinor: 50_00 },
        { holdingId: "c", valueMinor: 100_00 },
        { holdingId: "a", valueMinor: 400_00 },
      ],
    });

    expect(figures.slices.map((slice) => slice.holdingId)).toEqual(["a", "b", "c", "d"]);
  });

  test("an empty portfolio totals zero with no slices", () => {
    expect(computeManagedPortfolioFigures({ members: [] })).toEqual({
      slices: [],
      totalMinor: 0,
    });
  });

  test("weights are null while the total is zero — never a division by zero", () => {
    const figures = computeManagedPortfolioFigures({
      members: [{ holdingId: "cash", valueMinor: 0 }],
    });

    expect(figures.totalMinor).toBe(0);
    expect(figures.slices[0]).toEqual({
      holdingId: "cash",
      valueMinor: 0,
      weight: null,
    });
  });
});

describe("undetailedMemberName", () => {
  test("names the aggregate after the portfolio it stands for", () => {
    expect(undetailedMemberName("Cartera Indexada Metal")).toBe(
      "Cartera Indexada Metal (sin detallar)",
    );
  });
});

describe("managedPortfolioMemberRoles", () => {
  const types = new Map([
    ["cash", "cash"],
    ["agg", "manual"],
    ["f1", "investment"],
    ["f2", "investment"],
  ]);

  test("splits the container's plumbing from the funds", () => {
    expect(managedPortfolioMemberRoles(["cash", "agg", "f1", "f2"], types)).toEqual({
      cashHoldingId: "cash",
      investmentHoldingIds: ["f1", "f2"],
      undetailedHoldingId: "agg",
      unknownHoldingIds: [],
    });
  });

  test("a member with no live holding behind it is named, never silently dropped", () => {
    expect(managedPortfolioMemberRoles(["cash", "gone"], types)).toEqual({
      cashHoldingId: "cash",
      investmentHoldingIds: [],
      undetailedHoldingId: null,
      unknownHoldingIds: ["gone"],
    });
  });

  test("a portfolio born without an aggregate has none", () => {
    expect(managedPortfolioMemberRoles(["cash", "f1"], types).undetailedHoldingId).toBe(
      null,
    );
  });
});

describe("undetailedRemainderMinor", () => {
  test("what is left to detail: the declared balance minus the funds already typed", () => {
    expect(
      undetailedRemainderMinor({
        declaredMinor: 1_000_00,
        detailedInvestmentMinor: 400_00,
      }),
    ).toBe(600_00);
  });

  test("never negative: detailing past the declared balance suggests retiring it", () => {
    expect(
      undetailedRemainderMinor({
        declaredMinor: 1_000_00,
        detailedInvestmentMinor: 1_200_00,
      }),
    ).toBe(0);
  });

  test("no declared balance means no suggestion — nothing is derived from nothing", () => {
    expect(
      undetailedRemainderMinor({ declaredMinor: null, detailedInvestmentMinor: 400_00 }),
    ).toBe(null);
  });
});
