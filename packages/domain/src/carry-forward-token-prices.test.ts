/**
 * Carry-forward of a token's last-good live unit price across a re-sync.
 *
 * A connected-source sync replaces a source's positions wholesale and re-derives
 * each holding's value live (balance × unitPrice). A token whose price could not be
 * fetched this round arrives with `unitPrice: null` — which would value it 0,
 * silently zeroing a real, previously-valued holding on a single transient price
 * miss. {@link carryForwardTokenUnitPrices} keeps the value intact by carrying the
 * prior sync's last-good price forward (matched by stable `externalId`).
 */
import { describe, expect, test } from "vitest";

import { carryForwardTokenUnitPrices } from "./connected-source";
import type {
  CoinPosition,
  DistributiveOmit,
  SourcePosition,
  TokenPosition,
} from "./connected-source";

/** The token's unit price, or null for a coin / a missing row — narrows the
 *  carry-forward result union so the assertions stay type-clean. */
function priceOf(
  position: DistributiveOmit<SourcePosition, "id" | "sourceId"> | undefined,
): string | null {
  return position && position.kind === "token" ? position.unitPrice : null;
}

function token(overrides: Partial<TokenPosition> = {}): TokenPosition {
  return {
    kind: "token",
    id: "t1",
    sourceId: "src-binance",
    externalId: "WBETH:flexible-earn",
    name: "Wrapped Beacon ETH",
    symbol: "WBETH",
    balance: "2.07034748",
    wallet: "flexible-earn",
    liquidityTier: "market",
    unitPrice: "1655.37",
    imageUrl: null,
    currency: "EUR",
    ...overrides,
  };
}

function coin(): CoinPosition {
  return {
    kind: "coin",
    id: "c1",
    sourceId: "src-numista",
    externalId: "numista-1",
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
  };
}

describe("carryForwardTokenUnitPrices — a transient price miss never zeroes a valued token", () => {
  test("carries the prior sync's price forward when this sync priced the token null", () => {
    const previous: SourcePosition[] = [token({ unitPrice: "1655.37" })];
    const incoming = [token({ unitPrice: null })];

    const result = carryForwardTokenUnitPrices(incoming, previous);

    expect(result).toHaveLength(1);
    expect(priceOf(result[0])).toBe("1655.37");
  });

  test("does NOT override a freshly-fetched price (the live quote always wins)", () => {
    const previous: SourcePosition[] = [token({ unitPrice: "1655.37" })];
    const incoming = [token({ unitPrice: "1622.81" })];

    const result = carryForwardTokenUnitPrices(incoming, previous);

    expect(priceOf(result[0])).toBe("1622.81");
  });

  test("leaves a genuinely new, never-priced token null (nothing to carry forward)", () => {
    const incoming = [token({ externalId: "JEX:spot", unitPrice: null })];

    const result = carryForwardTokenUnitPrices(incoming, []);

    expect(priceOf(result[0])).toBeNull();
  });

  test("matches by externalId — an unrelated prior price is not borrowed", () => {
    const previous: SourcePosition[] = [
      token({ externalId: "BNB:spot", symbol: "BNB", unitPrice: "508.53" }),
    ];
    const incoming = [token({ externalId: "WBETH:flexible-earn", unitPrice: null })];

    const result = carryForwardTokenUnitPrices(incoming, previous);

    expect(priceOf(result[0])).toBeNull();
  });

  test("does not carry forward from a prior position that was itself unpriced", () => {
    const previous: SourcePosition[] = [token({ unitPrice: null })];
    const incoming = [token({ unitPrice: null })];

    const result = carryForwardTokenUnitPrices(incoming, previous);

    expect(priceOf(result[0])).toBeNull();
  });

  test("leaves coin positions untouched (coins freeze their own value)", () => {
    const incoming = [coin()];

    const result = carryForwardTokenUnitPrices(incoming, []);

    expect(result[0]).toEqual(coin());
  });

  test("is pure — returns a new array and never mutates its inputs", () => {
    const incomingToken = token({ unitPrice: null });
    const incoming = [incomingToken];
    const previous: SourcePosition[] = [token({ unitPrice: "1655.37" })];

    const result = carryForwardTokenUnitPrices(incoming, previous);

    expect(result).not.toBe(incoming);
    expect(incomingToken.unitPrice).toBeNull(); // input untouched
  });

  test("carries each token from its own match across a multi-token sync", () => {
    const previous: SourcePosition[] = [
      token({ externalId: "WBETH:flexible-earn", symbol: "WBETH", unitPrice: "1655.37" }),
      token({ externalId: "BNB:spot", symbol: "BNB", unitPrice: "508.53" }),
    ];
    const incoming = [
      token({ externalId: "WBETH:flexible-earn", symbol: "WBETH", unitPrice: null }),
      token({ externalId: "BNB:spot", symbol: "BNB", unitPrice: "509.10" }),
    ];

    const result = carryForwardTokenUnitPrices(incoming, previous);

    expect(priceOf(result[0])).toBe("1655.37"); // carried forward
    expect(priceOf(result[1])).toBe("509.10"); // fresh price wins
  });
});
