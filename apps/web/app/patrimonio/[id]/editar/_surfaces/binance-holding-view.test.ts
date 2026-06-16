/**
 * Unit tests for the pure Binance holding view (PRD #245, ADR 0021): per-token
 * live value, descending sort, total, and the basis tag. No React, no DB.
 */

import type { TokenPosition } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { buildBinanceHoldingView, tokenBasisTag } from "./binance-holding-view";

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

  test("an unpriceable token is kept with value 0 and the zero basis", () => {
    const view = buildBinanceHoldingView([
      token({ id: "1", symbol: "BTC", balance: "0.5", unitPrice: "50000" }),
      token({ id: "2", symbol: "WAGMI", balance: "100", unitPrice: null }),
    ]);

    expect(view.tokenCount).toBe(2);
    const wagmi = view.rows.find((r) => r.symbol === "WAGMI");
    expect(wagmi).toMatchObject({ valueMinor: 0, basis: "zero", unitPrice: null });
    // The valued token sorts ahead of the zero-value one.
    expect(view.rows[0]?.symbol).toBe("BTC");
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
