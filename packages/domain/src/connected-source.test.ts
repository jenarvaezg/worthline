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
  coinPositionSnapshotInput,
  coinValue,
  frozenInstrumentForAdapter,
  groupPositionsByMetal,
  groupPositionsByToken,
  instrumentForAdapter,
  isTokenDustValue,
  positionValue,
  projectConnectedSource,
  tokenSymbolSnapshotInputs,
} from "./connected-source";
import type { CoinPosition, ConnectedSource, TokenPosition } from "./connected-source";
import { defaultsFor } from "./instrument-catalog";

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
    obverseThumbUrl: null,
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
    imageUrl: null,
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

// rungForWallet is Binance-specific; its tests live in @worthline/pricing.

describe("instrumentForAdapter — the holding instrument a source projects into", () => {
  test("Numista projects a coin_collection; Binance a crypto holding", () => {
    expect(instrumentForAdapter("numista")).toBe("coin_collection");
    expect(instrumentForAdapter("binance")).toBe("crypto");
  });
});

describe("frozenInstrumentForAdapter — the hand-valued instrument a disconnect freeze keeps", () => {
  test("the frozen instrument is a STORED (hand-valued) one, never the live/derived source instrument", () => {
    // Freezing a disconnected source turns the derived/live holding into a plain
    // hand-maintained one (ADR 0016). The target must therefore be a `stored`
    // instrument — its value no longer tracks positions or a live price.
    expect(defaultsFor(frozenInstrumentForAdapter("numista")).valuationMethod).toBe(
      "stored",
    );
    expect(defaultsFor(frozenInstrumentForAdapter("binance")).valuationMethod).toBe(
      "stored",
    );
  });

  test("Numista freezes a coin collection into precious_metal; Binance crypto into a generic stored holding", () => {
    // A coin collection's physical nature is precious metal; crypto has no
    // hand-valued kind of its own, so it lands on the neutral `other` bucket.
    expect(frozenInstrumentForAdapter("numista")).toBe("precious_metal");
    expect(frozenInstrumentForAdapter("binance")).toBe("other");
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

describe("isTokenDustValue — junk worth under a cent (#479)", () => {
  test("a value that rounds to 0,00 € is dust (incl. unpriceable 'Valor 0')", () => {
    expect(isTokenDustValue(0)).toBe(true);
  });

  test("a value of one cent or more is not dust", () => {
    expect(isTokenDustValue(1)).toBe(false);
    expect(isTokenDustValue(2_500_000)).toBe(false);
  });
});

describe("tokenSymbolSnapshotInputs (ADR 0035, PRD #459 S2 — keyed by symbol, #247)", () => {
  test("folds a token spread across wallets into ONE position keyed by symbol", () => {
    // The whole point: a wallet move must NOT re-key the drilldown into a phantom
    // sell+buy. spot + funding + flexible-earn of one symbol collapse to one "BTC".
    const inputs = tokenSymbolSnapshotInputs([
      token({ externalId: "BTC:spot", wallet: "spot", balance: "0.5" }), // 25 000 €
      token({ externalId: "BTC:funding", wallet: "funding", balance: "0.1" }), // 5 000 €
      token({ externalId: "BTC:flexible-earn", wallet: "flexible-earn", balance: "0.4" }), // 20 000 €
    ]);

    expect(inputs).toEqual([
      {
        positionKey: "BTC", // the symbol — survives a wallet move (#247)
        label: "BTC",
        valueMinor: 5_000_000, // Σ balance × unit price across wallets
        metal: null,
        imageUrl: null,
      },
    ]);
  });

  test("freezes one position per distinct symbol", () => {
    const inputs = tokenSymbolSnapshotInputs([
      token({ symbol: "BTC", balance: "0.5", unitPrice: "50000" }), // 25 000 €
      token({ symbol: "ETH", balance: "2", unitPrice: "2000" }), // 4 000 €
    ]);

    expect(inputs.map((i) => i.positionKey)).toEqual(["BTC", "ETH"]);
    expect(inputs.map((i) => i.valueMinor)).toEqual([2_500_000, 400_000]);
  });

  test("an unpriceable token still freezes a row valued 0 (value-at-0 case)", () => {
    const inputs = tokenSymbolSnapshotInputs([
      token({
        externalId: "WAGMI:spot",
        symbol: "WAGMI",
        balance: "100",
        unitPrice: null,
      }),
    ]);

    expect(inputs).toEqual([
      {
        positionKey: "WAGMI",
        label: "WAGMI",
        valueMinor: 0,
        metal: null,
        imageUrl: null,
      },
    ]);
  });

  test("freezes the group's first non-null logo so the drilldown can render it (#482)", () => {
    const inputs = tokenSymbolSnapshotInputs([
      token({ externalId: "BTC:spot", wallet: "spot", imageUrl: null }),
      token({
        externalId: "BTC:funding",
        wallet: "funding",
        imageUrl: "https://coin-images.test/btc.png",
      }),
    ]);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.imageUrl).toBe("https://coin-images.test/btc.png");
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

describe("coinPositionSnapshotInput (ADR 0035)", () => {
  test("freezes a coin's stable key, name, value, metal and image for a snapshot", () => {
    const input = coinPositionSnapshotInput(
      coin({
        externalId: "numista-987",
        name: "Krugerrand 1 oz",
        metal: "oro",
        obverseThumbUrl: "https://numista.test/k.jpg",
        metalValueMinor: 180_000,
        numismaticValueMinor: 150_000,
        purchasePriceMinor: 120_000,
      }),
    );

    expect(input).toEqual({
      positionKey: "numista-987", // the stable externalId, NOT the internal id
      label: "Krugerrand 1 oz",
      valueMinor: 180_000, // coinValue: max(metal, numismatic) → metal
      metal: "oro",
      imageUrl: "https://numista.test/k.jpg",
    });
  });

  test("a coin with no metal/image freezes nulls, valued from its purchase price", () => {
    const input = coinPositionSnapshotInput(
      coin({
        externalId: "numista-1",
        name: "5 Pesetas",
        metal: null,
        obverseThumbUrl: null,
        metalValueMinor: null,
        numismaticValueMinor: null,
        purchasePriceMinor: 12_00,
      }),
    );

    expect(input).toEqual({
      positionKey: "numista-1",
      label: "5 Pesetas",
      valueMinor: 12_00, // falls back to purchase price (ADR 0017)
      metal: null,
      imageUrl: null,
    });
  });
});
