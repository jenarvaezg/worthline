/**
 * Unit tests for the pure Binance holding view (PRD #245, ADR 0021): per-token
 * live value, descending sort, total, and the basis tag. No React, no DB.
 */

import type { CoinPosition, TokenPosition } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  buildBinanceHoldingView,
  formatBinanceSince,
  formatWallets,
  tokenBasisTag,
  tokenPositionsOnRung,
} from "./binance-holding-view";

function token(over: Partial<TokenPosition> & { id: string }): TokenPosition {
  return {
    kind: "token",
    sourceId: "src",
    externalId: `${over.symbol ?? "X"}:spot`,
    name: over.symbol ?? "X",
    symbol: over.symbol ?? "X",
    balance: "0",
    wallet: "spot",
    liquidityTier: "market",
    unitPrice: null,
    currency: "EUR",
    ...over,
  };
}

function coin(over: Partial<CoinPosition> & { id: string }): CoinPosition {
  return {
    kind: "coin",
    sourceId: "src",
    externalId: `coin-${over.id}`,
    catalogueId: "1",
    name: "Moneda",
    grade: "MBC",
    quantity: 1,
    year: null,
    liquidityTier: "illiquid",
    metal: "gold",
    issueId: null,
    finenessMillis: null,
    weightGrams: null,
    purchaseDate: null,
    metalValueMinor: null,
    numismaticValueMinor: null,
    numismaticFetchedAt: null,
    purchasePriceMinor: null,
    obverseThumbUrl: null,
    currency: "EUR",
    ...over,
  };
}

describe("buildBinanceHoldingView", () => {
  test("values each token live (balance × unitPrice) and sorts by value desc", () => {
    const view = buildBinanceHoldingView([
      token({ id: "1", symbol: "ETH", balance: "2", unitPrice: "2000" }), // 4000.00 €
      token({ id: "2", symbol: "BTC", balance: "0.5", unitPrice: "50000" }), // 25000.00 €
    ]);

    expect(view.rows.map((r) => r.symbol)).toEqual(["BTC", "ETH"]);
    expect(view.rows[0]).toMatchObject({ symbol: "BTC", valueMinor: 2_500_000 });
    expect(view.rows[1]).toMatchObject({ symbol: "ETH", valueMinor: 400_000 });
    expect(view.totalMinor).toBe(2_900_000);
    expect(view.tokenCount).toBe(2);
  });

  test("groups a token spanning wallets into ONE row with the summed value (#247)", () => {
    const view = buildBinanceHoldingView([
      token({
        id: "1",
        symbol: "BTC",
        wallet: "spot",
        balance: "0.5",
        unitPrice: "50000",
      }), // 25 000 €
      token({
        id: "2",
        symbol: "BTC",
        wallet: "funding",
        balance: "0.1",
        unitPrice: "50000",
      }), // 5 000 €
      token({
        id: "3",
        symbol: "BTC",
        wallet: "flexible-earn",
        balance: "0.4",
        unitPrice: "50000",
      }), // 20 000 €
    ]);

    // ONE BTC row, value summed across the three wallets.
    expect(view.tokenCount).toBe(1);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ symbol: "BTC", valueMinor: 5_000_000 });
    expect(view.totalMinor).toBe(5_000_000);
    // Wallet origin surfaces as metadata on the row.
    expect(view.rows[0]!.wallets).toEqual(["spot", "funding", "flexible-earn"]);
  });

  test("an unpriceable (zero-value) token is hidden as dust by default (#479)", () => {
    const view = buildBinanceHoldingView([
      token({ id: "1", symbol: "BTC", balance: "0.5", unitPrice: "50000" }),
      token({ id: "2", symbol: "WAGMI", balance: "100", unitPrice: null }),
    ]);

    // The 0,00 € token is dropped from the rows and the count (display-only).
    expect(view.rows.map((r) => r.symbol)).toEqual(["BTC"]);
    expect(view.tokenCount).toBe(1);
    // The total is unchanged — dust is worth nothing anyway.
    expect(view.totalMinor).toBe(2_500_000);
  });

  test("a priced token worth under a cent is hidden, total intact (#479)", () => {
    const view = buildBinanceHoldingView([
      token({ id: "1", symbol: "BTC", balance: "0.5", unitPrice: "50000" }), // 25 000 €
      token({ id: "2", symbol: "SHIB", balance: "0.004", unitPrice: "1" }), // 0,004 € → 0 minor
    ]);

    expect(view.rows.map((r) => r.symbol)).toEqual(["BTC"]);
    expect(view.tokenCount).toBe(1);
    expect(view.totalMinor).toBe(2_500_000);
  });

  test("an empty holding is a zero total with no rows", () => {
    expect(buildBinanceHoldingView([])).toEqual({
      totalMinor: 0,
      tokenCount: 0,
      rows: [],
    });
  });
});

describe("tokenBasisTag", () => {
  test("labels market vs zero with the shared tag classes", () => {
    expect(tokenBasisTag("market")).toEqual({ label: "Mercado", cls: "coinTagMetal" });
    expect(tokenBasisTag("zero")).toEqual({ label: "Valor 0", cls: "coinTagZero" });
  });
});

describe("formatWallets", () => {
  test("labels and dot-joins the wallets a token spans, de-duplicating (#247)", () => {
    expect(formatWallets(["spot", "funding", "flexible-earn"])).toBe(
      "spot · funding · Earn flexible",
    );
    expect(formatWallets(["spot", "spot"])).toBe("spot");
    expect(formatWallets([])).toBe("");
  });

  test("labels the locked-earn (term-locked) wallet (#248)", () => {
    expect(formatWallets(["locked-earn"])).toBe("Earn bloqueado");
  });
});

describe("tokenPositionsOnRung", () => {
  test("the market rung returns only the market token positions (#248)", () => {
    const rows = tokenPositionsOnRung(
      [
        token({ id: "1", symbol: "BTC", liquidityTier: "market" }),
        token({ id: "2", symbol: "ETH", liquidityTier: "market" }),
        token({ id: "3", symbol: "ADA", liquidityTier: "term-locked" }),
      ],
      "market",
    );

    expect(rows.map((p) => p.symbol)).toEqual(["BTC", "ETH"]);
    expect(rows.every((p) => p.liquidityTier === "market")).toBe(true);
  });

  test("the term-locked rung returns only the locked token positions (#248)", () => {
    const rows = tokenPositionsOnRung(
      [
        token({ id: "1", symbol: "BTC", liquidityTier: "market" }),
        token({ id: "2", symbol: "ETH", liquidityTier: "term-locked" }),
      ],
      "term-locked",
    );

    expect(rows.map((p) => p.symbol)).toEqual(["ETH"]);
    expect(rows[0]!.liquidityTier).toBe("term-locked");
  });

  test("coin positions and tokens on other rungs are excluded", () => {
    const rows = tokenPositionsOnRung(
      [
        token({ id: "1", symbol: "BTC", liquidityTier: "market" }),
        token({ id: "2", symbol: "ETH", liquidityTier: "term-locked" }),
        coin({ id: "3", liquidityTier: "market" }), // a coin on the market rung
        coin({ id: "4", liquidityTier: "illiquid" }),
      ],
      "market",
    );

    // Only the market TOKEN — the same-rung coin and the locked token are dropped.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "token", symbol: "BTC" });
  });
});

describe("formatBinanceSince", () => {
  test("renders a DD/MM/YYYY es-ES label from the curve-start date key", () => {
    expect(formatBinanceSince("2026-03-31")).toBe("Datos desde 31/03/2026");
    expect(formatBinanceSince("2026-01-01")).toBe("Datos desde 01/01/2026");
  });

  test("is null when there is no curve start", () => {
    expect(formatBinanceSince(null)).toBeNull();
  });
});
