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

import {
  coinCollectionValueAtDate,
  coinValue,
  groupPositionsByMetal,
  groupPositionsByToken,
  instrumentForAdapter,
  positionValue,
  projectConnectedSource,
  rungForWallet,
} from "./connected-source";
import type { CoinPosition, ConnectedSource, TokenPosition } from "./connected-source";

const source: ConnectedSource = {
  id: "src-numista",
  adapter: "numista",
  label: "Colección Numista",
  ownership: [{ memberId: "m1", shareBps: 10_000 }],
};

const binanceSource: ConnectedSource = {
  id: "src-binance",
  adapter: "binance",
  label: "Binance",
  ownership: [{ memberId: "m1", shareBps: 10_000 }],
};

function coin(overrides: Partial<CoinPosition> = {}): CoinPosition {
  return {
    kind: "coin",
    id: "p1",
    sourceId: "src-numista",
    externalId: "ext-p1",
    catalogueId: "1234",
    name: "20 francos Marianne",
    grade: "unc",
    quantity: 1,
    year: null,
    liquidityTier: "illiquid",
    metal: "oro",
    issueId: null,
    finenessMillis: null,
    weightGrams: null,
    purchaseDate: "2019-05-12",
    metalValueMinor: null,
    numismaticValueMinor: null,
    numismaticFetchedAt: null,
    purchasePriceMinor: 30_000,
    currency: "EUR",
    ...overrides,
  };
}

function token(overrides: Partial<TokenPosition> = {}): TokenPosition {
  return {
    kind: "token",
    id: "t1",
    sourceId: "src-binance",
    externalId: "BTC:spot",
    name: "Bitcoin",
    symbol: "BTC",
    balance: "0.5",
    wallet: "spot",
    liquidityTier: "market",
    unitPrice: "50000",
    currency: "EUR",
    ...overrides,
  };
}

describe("positionValue — a token balance valued live (balance × price, ADR 0021)", () => {
  test("values a token balance as balance × unit price → minor units", () => {
    // 0.5 BTC × 50 000.50 €/BTC = 25 000.25 € = 2 500 025 minor.
    expect(positionValue("0.5", "50000.50")).toEqual({
      minor: 2_500_025,
      basis: "market",
    });
  });

  test("handles fractional crypto balances at full precision", () => {
    // 1.23456789 ETH × 2 000 €/ETH = 2 469.13578 € → 246 914 minor (half-up).
    expect(positionValue("1.23456789", "2000")).toEqual({
      minor: 246_914,
      basis: "market",
    });
  });

  test("falls to value 0 with a 'zero' basis when the token cannot be priced", () => {
    // An unmapped/unpriceable symbol carries a null price → 0 + warning basis,
    // never silently dropped (ADR 0021).
    expect(positionValue("0.5", null)).toEqual({ minor: 0, basis: "zero" });
  });

  test("a zero balance is worth 0 on the market basis (priced, just empty)", () => {
    expect(positionValue("0", "50000")).toEqual({ minor: 0, basis: "market" });
  });
});

describe("coinValue — max(metal, numismatic) → purchase price → 0 (ADR 0017)", () => {
  test("takes the metal value when it beats the numismatic estimate", () => {
    const v = coinValue(coin({ metalValueMinor: 53_800, numismaticValueMinor: 49_000 }));
    expect(v).toEqual({ minor: 53_800, basis: "metal" });
  });

  test("takes the numismatic estimate when it beats the metal value", () => {
    const v = coinValue(coin({ metalValueMinor: 1_900, numismaticValueMinor: 4_800 }));
    expect(v).toEqual({ minor: 4_800, basis: "numismatic" });
  });

  test("a tie resolves to metal (bullion floor)", () => {
    const v = coinValue(coin({ metalValueMinor: 7_500, numismaticValueMinor: 7_500 }));
    expect(v).toEqual({ minor: 7_500, basis: "metal" });
  });

  test("falls back to the purchase price when neither metal nor numismatic is known", () => {
    const v = coinValue(
      coin({
        metalValueMinor: null,
        numismaticValueMinor: null,
        purchasePriceMinor: 30_000,
      }),
    );
    expect(v).toEqual({ minor: 30_000, basis: "purchase" });
  });

  test("a base-metal coin Numista does not estimate, with no purchase price, is 0", () => {
    const v = coinValue(
      coin({ metalValueMinor: 0, numismaticValueMinor: null, purchasePriceMinor: null }),
    );
    expect(v).toEqual({ minor: 0, basis: "zero" });
  });

  test("a known zero metal value still loses to a positive numismatic estimate", () => {
    const v = coinValue(coin({ metalValueMinor: 0, numismaticValueMinor: 1_600 }));
    expect(v).toEqual({ minor: 1_600, basis: "numismatic" });
  });
});

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

describe("projectConnectedSource — Binance tokens roll up live-valued (ADR 0021)", () => {
  test("spot tokens project to one market crypto holding valued Σ(balance × price)", () => {
    const holdings = projectConnectedSource(binanceSource, [
      token({ id: "t1", symbol: "BTC", balance: "0.5", unitPrice: "50000" }), // 25 000 €
      token({ id: "t2", symbol: "ETH", balance: "2", unitPrice: "2000" }), // 4 000 €
    ]);

    expect(holdings).toHaveLength(1);
    const holding = holdings[0]!;
    expect(holding.liquidityTier).toBe("market");
    expect(holding.instrument).toBe("crypto");
    expect(holding.name).toBe("Binance");
    expect(holding.currency).toBe("EUR");
    expect(holding.valueMinor).toBe(2_900_000);
    expect(holding.ownership).toEqual(binanceSource.ownership);
    expect(holding.positions).toHaveLength(2);
  });

  test("an unpriceable token contributes 0 but stays in the holding (value-at-0 case)", () => {
    const holdings = projectConnectedSource(binanceSource, [
      token({ id: "t1", symbol: "BTC", balance: "0.5", unitPrice: "50000" }),
      token({ id: "t2", symbol: "WAT", balance: "100", unitPrice: null }),
    ]);

    expect(holdings[0]!.valueMinor).toBe(2_500_000);
    expect(holdings[0]!.positions).toHaveLength(2);
  });

  test("the SAME token on two market wallets sums into ONE market holding value (#247)", () => {
    const holdings = projectConnectedSource(binanceSource, [
      token({
        id: "t1",
        externalId: "BTC:spot",
        symbol: "BTC",
        balance: "0.5",
        unitPrice: "50000",
      }), // 25 000 €
      token({
        id: "t2",
        externalId: "BTC:funding",
        symbol: "BTC",
        balance: "0.1",
        unitPrice: "50000",
      }), // 5 000 €
    ]);

    // Both wallets are market-rung → one holding whose value sums the two positions.
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.liquidityTier).toBe("market");
    expect(holdings[0]!.valueMinor).toBe(3_000_000);
    expect(holdings[0]!.positions).toHaveLength(2);
  });

  test("market + locked positions split into TWO holdings, one per rung (S3, #248)", () => {
    const holdings = projectConnectedSource(binanceSource, [
      token({
        id: "t1",
        externalId: "BTC:spot",
        symbol: "BTC",
        balance: "0.5",
        unitPrice: "50000",
        liquidityTier: "market",
      }), // 25 000 € on market
      token({
        id: "t2",
        externalId: "ETH:locked-earn",
        symbol: "ETH",
        balance: "3",
        unitPrice: "2000",
        liquidityTier: "term-locked",
      }), // 6 000 € on term-locked
    ]);

    expect(holdings).toHaveLength(2);
    const byTier = new Map(holdings.map((h) => [h.liquidityTier, h]));

    const market = byTier.get("market")!;
    expect(market.instrument).toBe("crypto");
    expect(market.valueMinor).toBe(2_500_000);
    expect(market.positions).toHaveLength(1);

    const locked = byTier.get("term-locked")!;
    expect(locked.instrument).toBe("crypto");
    expect(locked.valueMinor).toBe(600_000);
    expect(locked.positions).toHaveLength(1);
  });
});

describe("rungForWallet — Binance wallet → liquidity rung (ADR 0016, S3)", () => {
  test("spot, funding and flexible-earn are market-liquid", () => {
    expect(rungForWallet("spot")).toBe("market");
    expect(rungForWallet("funding")).toBe("market");
    expect(rungForWallet("flexible-earn")).toBe("market");
  });

  test("locked-earn and staking are term-locked", () => {
    expect(rungForWallet("locked-earn")).toBe("term-locked");
    expect(rungForWallet("staking")).toBe("term-locked");
  });

  test("an unforeseen wallet defaults to market (most conservative claim)", () => {
    expect(rungForWallet("mystery")).toBe("market");
  });
});

describe("instrumentForAdapter — the holding instrument a source projects into", () => {
  test("Numista projects a coin_collection; Binance a crypto holding", () => {
    expect(instrumentForAdapter("numista")).toBe("coin_collection");
    expect(instrumentForAdapter("binance")).toBe("crypto");
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

describe("groupPositionsByToken — the Binance detail lens (grouped by symbol, #247)", () => {
  test("a token across spot+funding+flexible-earn groups into ONE summed token group", () => {
    const groups = groupPositionsByToken([
      token({
        id: "t1",
        externalId: "BTC:spot",
        wallet: "spot",
        symbol: "BTC",
        balance: "0.5",
        unitPrice: "50000",
      }), // 25 000 €
      token({
        id: "t2",
        externalId: "BTC:funding",
        wallet: "funding",
        symbol: "BTC",
        balance: "0.1",
        unitPrice: "50000",
      }), // 5 000 €
      token({
        id: "t3",
        externalId: "BTC:flexible-earn",
        wallet: "flexible-earn",
        symbol: "BTC",
        balance: "0.4",
        unitPrice: "50000",
      }), // 20 000 €
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ symbol: "BTC", subtotalMinor: 5_000_000 });
    expect(groups[0]!.positions).toHaveLength(3);
    // Wallet origin survives as per-position metadata on the group.
    expect(groups[0]!.positions.map((p) => p.wallet)).toEqual([
      "spot",
      "funding",
      "flexible-earn",
    ]);
  });

  test("orders most valuable token first, ties broken by symbol asc", () => {
    const groups = groupPositionsByToken([
      token({ id: "t1", symbol: "ETH", balance: "2", unitPrice: "2000" }), // 4 000 €
      token({ id: "t2", symbol: "BTC", balance: "0.5", unitPrice: "50000" }), // 25 000 €
    ]);

    expect(groups.map((g) => g.symbol)).toEqual(["BTC", "ETH"]);
    expect(groups[0]).toMatchObject({ symbol: "BTC", subtotalMinor: 2_500_000 });
    expect(groups[1]).toMatchObject({ symbol: "ETH", subtotalMinor: 400_000 });
  });

  test("an unpriceable token still groups with subtotal 0 (value-at-0 case)", () => {
    const groups = groupPositionsByToken([
      token({ id: "t1", symbol: "WAGMI", balance: "100", unitPrice: null }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ symbol: "WAGMI", subtotalMinor: 0 });
    expect(groups[0]!.positions).toHaveLength(1);
  });
});

describe("coinCollectionValueAtDate — purchase-date accretion (ADR 0017)", () => {
  test("sums only coins acquired on or before the date", () => {
    const positions = [
      coin({ id: "a", purchaseDate: "2024-01-01", purchasePriceMinor: 100_00 }),
      coin({ id: "b", purchaseDate: "2024-06-01", purchasePriceMinor: 200_00 }),
    ];
    // Before any coin → 0; between the two → only the first; after both → both.
    expect(coinCollectionValueAtDate(positions, "2023-12-31")).toBe(0);
    expect(coinCollectionValueAtDate(positions, "2024-03-01")).toBe(100_00);
    expect(coinCollectionValueAtDate(positions, "2024-06-01")).toBe(300_00);
  });

  test("excludes coins with no purchase date (no dated fact to place)", () => {
    const positions = [
      coin({ id: "dated", purchaseDate: "2024-01-01", purchasePriceMinor: 100_00 }),
      coin({ id: "undated", purchaseDate: null, purchasePriceMinor: 999_00 }),
    ];
    expect(coinCollectionValueAtDate(positions, "2024-12-31")).toBe(100_00);
  });
});
