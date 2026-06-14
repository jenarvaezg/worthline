/**
 * Connected source projection (PRD #160, ADR 0016/0017).
 *
 * A connected source mirrors external positions read-only and PROJECTS them into
 * the portfolio as one rolled-up holding per liquidity-ladder rung. Numista's
 * coins are all illiquid, so a Numista source yields a single "Colección Numista"
 * holding whose value is the sum of its positions' coin values. These tests
 * assert that projection behaviour, not how the value is stored.
 */
import { describe, expect, test } from "vitest";

import { groupPositionsByMetal, projectConnectedSource } from "./connected-source";
import type { ConnectedSource, SourcePosition } from "./connected-source";

const source: ConnectedSource = {
  id: "src-numista",
  adapter: "numista",
  label: "Colección Numista",
  ownership: [{ memberId: "m1", shareBps: 10_000 }],
};

function coin(overrides: Partial<SourcePosition> = {}): SourcePosition {
  return {
    id: "p1",
    sourceId: "src-numista",
    catalogueId: "1234",
    name: "20 francos Marianne",
    grade: "EBC",
    quantity: 1,
    liquidityTier: "illiquid",
    metal: "oro",
    purchaseDate: "2019-05-12",
    purchasePriceMinor: 30_000,
    currency: "EUR",
    ...overrides,
  };
}

describe("projectConnectedSource — positions roll up into one holding per rung", () => {
  test("a Numista collection projects to one illiquid holding valued at the sum of purchase prices", () => {
    const positions = [
      coin({ id: "p1", purchasePriceMinor: 30_000 }),
      coin({ id: "p2", purchasePriceMinor: 41_000 }),
      coin({ id: "p3", purchasePriceMinor: 22_000 }),
    ];

    const holdings = projectConnectedSource(source, positions);

    expect(holdings).toHaveLength(1);
    const holding = holdings[0]!;
    expect(holding.liquidityTier).toBe("illiquid");
    expect(holding.instrument).toBe("coin_collection");
    expect(holding.name).toBe("Colección Numista");
    expect(holding.currency).toBe("EUR");
    expect(holding.valueMinor).toBe(93_000);
    expect(holding.ownership).toEqual(source.ownership);
    expect(holding.positions).toHaveLength(3);
  });

  test("a source whose positions span rungs splits into one holding per rung", () => {
    // Numista cannot span rungs, but the framework is built for a source that
    // can (ADR 0016): each rung rolls up its own positions and value.
    const positions = [
      coin({ id: "p1", liquidityTier: "illiquid", purchasePriceMinor: 30_000 }),
      coin({ id: "p2", liquidityTier: "illiquid", purchasePriceMinor: 20_000 }),
      coin({ id: "p3", liquidityTier: "market", purchasePriceMinor: 5_000 }),
    ];

    const holdings = projectConnectedSource(source, positions);

    expect(holdings).toHaveLength(2);
    const byTier = new Map(holdings.map((h) => [h.liquidityTier, h]));
    expect(byTier.get("illiquid")?.valueMinor).toBe(50_000);
    expect(byTier.get("illiquid")?.positions).toHaveLength(2);
    expect(byTier.get("market")?.valueMinor).toBe(5_000);
    expect(byTier.get("market")?.positions).toHaveLength(1);
  });

  test("an empty collection projects to no holdings", () => {
    expect(projectConnectedSource(source, [])).toEqual([]);
  });

  test("a coin with no purchase price contributes 0 but still belongs to the holding", () => {
    const holdings = projectConnectedSource(source, [
      coin({ id: "p1", purchasePriceMinor: 30_000 }),
      coin({ id: "p2", purchasePriceMinor: null }),
    ]);

    expect(holdings[0]!.valueMinor).toBe(30_000);
    expect(holdings[0]!.positions).toHaveLength(2);
  });
});

describe("groupPositionsByMetal — the detail-page lens (grouped by metal)", () => {
  test("groups positions by metal, sums each group, orders most valuable first", () => {
    const groups = groupPositionsByMetal([
      coin({ id: "p1", metal: "oro", purchasePriceMinor: 30_000 }),
      coin({ id: "p2", metal: "plata", purchasePriceMinor: 4_000 }),
      coin({ id: "p3", metal: "oro", purchasePriceMinor: 20_000 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ metal: "oro", subtotalMinor: 50_000 });
    expect(groups[0]!.positions).toHaveLength(2);
    expect(groups[1]).toMatchObject({ metal: "plata", subtotalMinor: 4_000 });
  });

  test("positions without a metal collect under one null group, listed last", () => {
    const groups = groupPositionsByMetal([
      coin({ id: "p1", metal: null, purchasePriceMinor: 50_000 }),
      coin({ id: "p2", metal: "plata", purchasePriceMinor: 4_000 }),
    ]);

    expect(groups[0]!.metal).toBe("plata");
    expect(groups[1]!.metal).toBeNull();
    expect(groups[1]!.subtotalMinor).toBe(50_000);
  });
});
