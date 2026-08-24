import { describe, expect, test } from "vitest";

import {
  assertUndetailedValueInput,
  managedPortfolioMemberRoles,
  undetailedMemberName,
  undetailedRemainderMinor,
} from "./managed-portfolio-members";

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
      detailedHoldingIds: ["f1", "f2"],
      undetailedHoldingId: "agg",
      unknownHoldingIds: [],
    });
  });

  test("a member with no live holding behind it is named, never silently dropped", () => {
    expect(managedPortfolioMemberRoles(["cash", "gone"], types)).toEqual({
      cashHoldingId: "cash",
      detailedHoldingIds: [],
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

describe("assertUndetailedValueInput", () => {
  test("accepts money", () => {
    expect(() => assertUndetailedValueInput(1_000_00)).not.toThrow();
  });

  test("refuses a 0 € aggregate — it would stand for nothing", () => {
    expect(() => assertUndetailedValueInput(0)).toThrow(/importe positivo/);
  });
});
