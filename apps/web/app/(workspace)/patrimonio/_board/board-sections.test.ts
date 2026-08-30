import {
  isClosedPosition,
  paneSegments,
  sectionsFor,
  sectionTotal,
  unitMagnitude,
} from "@web/patrimonio/_board/board-sections";
import type { BoardUnit, PortfolioGroup, UnifiedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";

function asset(
  id: string,
  valueMinor: number,
  opts: { derived?: boolean; tier?: UnifiedHolding["tier"] } = {},
): UnifiedHolding {
  return {
    direction: "asset",
    id,
    instrument: "fund",
    name: id,
    ownership: { shares: [], totalShareBps: 10_000 },
    priceFetchedAt: null,
    priceSource: null,
    tier: opts.tier ?? "market",
    tierLabel: "Mercado",
    valueIsDerived: opts.derived ?? false,
    valueMinor,
  };
}

function liability(id: string, balanceMinor: number): UnifiedHolding {
  return {
    balanceMinor,
    direction: "liability",
    id,
    instrument: "mortgage",
    name: id,
    ownership: { shares: [], totalShareBps: 10_000 },
    tier: "housing",
    tierLabel: "Vivienda",
  };
}

function holdingUnit(holding: UnifiedHolding): BoardUnit {
  return {
    holding,
    key: holding.id,
    kind: "holding",
    signedMinor:
      holding.direction === "asset" ? holding.valueMinor : -holding.balanceMinor,
  };
}

function portfolioUnit(id: string, members: UnifiedHolding[]): BoardUnit {
  return {
    instrument: "fund",
    key: id,
    kind: "portfolio",
    members,
    portfolio: { holdingIds: members.map((m) => m.id), id, name: id, provider: null },
    signedMinor: members.reduce(
      (acc, m) => acc + (m.direction === "asset" ? m.valueMinor : 0),
      0,
    ),
    tier: "market",
  };
}

function group(key: string, units: BoardUnit[]): PortfolioGroup {
  return {
    holdings: units.flatMap((u) => (u.kind === "holding" ? [u.holding] : u.members)),
    key,
    label: key,
    totalMinor: { amountMinor: 0, currency: "EUR" },
    units,
  };
}

describe("sectionsFor (#1608)", () => {
  test("keeps one direction, largest summand first", () => {
    const groups = [
      group("mixed", [
        holdingUnit(asset("small", 1_00)),
        holdingUnit(liability("mortgage", 500_00)),
        holdingUnit(asset("big", 9_00)),
      ]),
    ];

    expect(sectionsFor(groups, "asset").map((s) => s.units.map((u) => u.key))).toEqual([
      ["big", "small"],
    ]);
    expect(
      sectionsFor(groups, "liability").map((s) => s.units.map((u) => u.key)),
    ).toEqual([["mortgage"]]);
  });

  test("a managed portfolio is an asset summand, never a liability one", () => {
    const groups = [group("market", [portfolioUnit("prt", [asset("member", 10_00)])])];

    expect(sectionsFor(groups, "asset")).toHaveLength(1);
    expect(sectionsFor(groups, "liability")).toEqual([]);
  });

  test("drops a section left with no summand on this side", () => {
    const groups = [
      group("market", [holdingUnit(asset("a", 5_00))]),
      group("housing", [holdingUnit(liability("l", 5_00))]),
    ];

    expect(sectionsFor(groups, "asset").map((s) => s.key)).toEqual(["market"]);
  });

  test("does not mutate the projection it was handed", () => {
    const units = [holdingUnit(asset("small", 1_00)), holdingUnit(asset("big", 9_00))];
    const groups = [group("market", units)];

    sectionsFor(groups, "asset");

    expect(units.map((u) => u.key)).toEqual(["small", "big"]);
  });

  test("a section's total is the sum of its summands, blocks counted whole", () => {
    const units = [
      holdingUnit(asset("loose", 1_00)),
      portfolioUnit("prt", [asset("m1", 2_00), asset("m2", 3_00)]),
    ];

    expect(units.map(unitMagnitude)).toEqual([1_00, 5_00]);
    expect(sectionTotal(units)).toBe(6_00);
  });
});

describe("isClosedPosition (#1608)", () => {
  const operated = new Set(["sold"]);

  test("a derived 0 WITH operations is a fully-sold position", () => {
    expect(isClosedPosition(asset("sold", 0, { derived: true }), operated)).toBe(true);
  });

  test("a derived 0 with no operation is just-created, not sold out", () => {
    expect(isClosedPosition(asset("fresh", 0, { derived: true }), operated)).toBe(false);
  });

  test("a stored 0 stays visible — for those, 0 IS the anomaly", () => {
    expect(isClosedPosition(asset("sold", 0), operated)).toBe(false);
  });

  test("a debt never folds away", () => {
    expect(isClosedPosition(liability("sold", 0), operated)).toBe(false);
  });
});

describe("paneSegments (#1608)", () => {
  test("a subdivided pane reads by subsection, in each rung's colour", () => {
    const sections = sectionsFor(
      [
        group("market", [holdingUnit(asset("a", 3_00))]),
        group("housing", [holdingUnit(asset("h", 1_00, { tier: "housing" }))]),
      ],
      "asset",
    );

    expect(paneSegments(sections, true)).toEqual({
      denom: 4_00,
      segments: [
        { color: "var(--tier-market)", key: "market", label: "market", value: 3_00 },
        { color: "var(--tier-housing)", key: "housing", label: "housing", value: 1_00 },
      ],
    });
  });

  test("a single-section pane reads by holding — one flat block says nothing", () => {
    const sections = sectionsFor(
      [
        group("market", [
          holdingUnit(asset("big", 9_00)),
          holdingUnit(asset("small", 1_00)),
        ]),
      ],
      "asset",
    );

    expect(paneSegments(sections, true).segments.map((s) => s.key)).toEqual([
      "big",
      "small",
    ]);
  });

  test("a debt segment speaks the debit hue, never a rung colour (canon §6)", () => {
    const sections = sectionsFor(
      [
        group("housing", [holdingUnit(liability("m", 5_00))]),
        group("consumo", [holdingUnit(liability("c", 1_00))]),
      ],
      "liability",
    );

    expect(paneSegments(sections, false).segments.map((s) => s.color)).toEqual([
      "var(--debit-rule)",
      "var(--debit-rule)",
    ]);
  });

  test("an empty pane divides by 1 instead of painting NaN%", () => {
    expect(paneSegments([], true)).toEqual({ denom: 1, segments: [] });
  });
});
