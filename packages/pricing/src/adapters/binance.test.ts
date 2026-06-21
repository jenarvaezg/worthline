/**
 * Unit tests for the Binance connected-source adapter (ADR 0021/0027, #322).
 *
 * The adapter owns Binance's credential parsing, wallet→rung classification, the
 * position listing (delegating to `syncBinanceAccount`) and the monthly history
 * (delegating to `reconstructBinanceHistory`). `rungForWallet` was relocated here
 * out of `@worthline/domain` (#322), so the wallet→rung map is tested here now.
 */
import { describe, expect, test } from "vitest";

import { binanceAdapter } from "./binance";
import type { SyncContext, HistoryContext } from "./types";
import type { BinanceCreds } from "./binance";

function syncCtx(
  partial: Partial<SyncContext<BinanceCreds, null>>,
): SyncContext<BinanceCreds, null> {
  return {
    creds: { apiKey: "key", apiSecret: "secret" },
    token: null,
    saveToken: () => {},
    nowIso: "2026-06-18T00:00:00.000Z",
    nowMs: Date.parse("2026-06-18T00:00:00.000Z"),
    ...partial,
  };
}

describe("binanceAdapter — metadata (ADR 0021/0027)", () => {
  test("carries the persisted tag + the crypto/other instruments + the bloqueado suffix", () => {
    expect(binanceAdapter.tag).toBe("binance");
    expect(binanceAdapter.liveInstrument).toBe("crypto");
    expect(binanceAdapter.frozenInstrument).toBe("other");
    expect(binanceAdapter.termLockedSuffix).toBe("(bloqueado)");
  });

  test("Binance revalue is a full re-list, so the in-place revalue is null", () => {
    expect(binanceAdapter.revalue).toBeNull();
  });
});

describe("binanceAdapter — credential parsing (folded in from binance-helpers)", () => {
  test("parseConnectForm reads key + secret, trimming, returning null when either is blank", () => {
    const fd = new FormData();
    fd.set("apiKey", "  the-key  ");
    fd.set("apiSecret", "  the-secret  ");
    expect(binanceAdapter.parseConnectForm(fd)).toEqual({
      apiKey: "the-key",
      apiSecret: "the-secret",
    });

    const missingSecret = new FormData();
    missingSecret.set("apiKey", "the-key");
    expect(binanceAdapter.parseConnectForm(missingSecret)).toBeNull();

    expect(binanceAdapter.parseConnectForm(new FormData())).toBeNull();
  });

  test("serializeCredentials round-trips through readCredentials", () => {
    const creds: BinanceCreds = { apiKey: "k", apiSecret: "s" };
    const json = binanceAdapter.serializeCredentials(creds);
    expect(JSON.parse(json)).toEqual({ apiKey: "k", apiSecret: "s" });
    expect(binanceAdapter.readCredentials(json)).toEqual(creds);
  });

  test("readCredentials returns null on malformed json or a missing half", () => {
    expect(binanceAdapter.readCredentials("not json")).toBeNull();
    expect(binanceAdapter.readCredentials(JSON.stringify({ apiKey: "k" }))).toBeNull();
    expect(
      binanceAdapter.readCredentials(JSON.stringify({ apiKey: "k", apiSecret: "" })),
    ).toBeNull();
  });
});

describe("binanceAdapter.classifyRung — wallet → rung (the relocated rungForWallet)", () => {
  test("spot, funding and flexible-earn token positions are market-liquid", () => {
    for (const wallet of ["spot", "funding", "flexible-earn"]) {
      expect(
        binanceAdapter.classifyRung({
          kind: "token",
          externalId: `BTC:${wallet}`,
          name: "BTC",
          symbol: "BTC",
          balance: "1",
          wallet,
          liquidityTier: "market",
          unitPrice: "1",
          imageUrl: null,
          currency: "EUR",
        }),
      ).toBe("market");
    }
  });

  test("locked-earn and staking token positions are term-locked", () => {
    for (const wallet of ["locked-earn", "staking"]) {
      expect(
        binanceAdapter.classifyRung({
          kind: "token",
          externalId: `ETH:${wallet}`,
          name: "ETH",
          symbol: "ETH",
          balance: "1",
          wallet,
          liquidityTier: "market",
          unitPrice: "1",
          imageUrl: null,
          currency: "EUR",
        }),
      ).toBe("term-locked");
    }
  });

  test("an unforeseen wallet defaults to market (most conservative claim)", () => {
    expect(
      binanceAdapter.classifyRung({
        kind: "token",
        externalId: "BTC:mystery",
        name: "BTC",
        symbol: "BTC",
        balance: "1",
        wallet: "mystery",
        liquidityTier: "market",
        unitPrice: "1",
        imageUrl: null,
        currency: "EUR",
      }),
    ).toBe("market");
  });
});

describe("binanceAdapter.listPositions — delegates to syncBinanceAccount", () => {
  test("lists balances + prices them live, stamping the wallet's rung", async () => {
    const drafts = await binanceAdapter.listPositions(
      syncCtx({
        listBalances: async () => [
          { asset: "BTC", wallet: "spot", balance: "0.5" },
          { asset: "ETH", wallet: "locked-earn", balance: "3" },
        ],
        priceEur: async (id) => ({ bitcoin: 50_000, ethereum: 2_000 })[id] ?? null,
      }),
    );

    expect(drafts).toEqual([
      {
        kind: "token",
        externalId: "BTC:spot",
        name: "BTC",
        symbol: "BTC",
        balance: "0.5",
        wallet: "spot",
        liquidityTier: "market",
        unitPrice: "50000",
        imageUrl: null,
        currency: "EUR",
      },
      {
        kind: "token",
        externalId: "ETH:locked-earn",
        name: "ETH",
        symbol: "ETH",
        balance: "3",
        wallet: "locked-earn",
        liquidityTier: "term-locked",
        unitPrice: "2000",
        imageUrl: null,
        currency: "EUR",
      },
    ]);
  });

  test("throws when the balance/price readers are not wired", async () => {
    await expect(binanceAdapter.listPositions(syncCtx({}))).rejects.toThrow();
  });
});

describe("binanceAdapter.buildHistory — delegates to reconstructBinanceHistory", () => {
  test("reconstructs the monthly curve from snapshots + a daily price series", async () => {
    const ctx: HistoryContext<BinanceCreds, null> = {
      creds: { apiKey: "key", apiSecret: "secret" },
      token: null,
      nowIso: "2026-06-18T00:00:00.000Z",
      nowMs: Date.parse("2026-06-18T00:00:00.000Z"),
      accountSnapshots: async () => [
        { dateKey: "2020-01-31", balances: [{ asset: "BTC", balance: "0.5" }] },
      ],
      historicalPriceEur: async () => new Map([["2020-01-31", "30000"]]),
    };

    const curve = await binanceAdapter.buildHistory!(ctx);
    expect(curve.monthEndBalances.get("BTC")?.get("2020-01")).toBe("0.5");
    expect(curve.dailyPriceBySymbol.get("BTC")?.get("2020-01-31")).toBe("30000");
  });

  test("throws when the history readers are not wired", async () => {
    const ctx: HistoryContext<BinanceCreds, null> = {
      creds: { apiKey: "key", apiSecret: "secret" },
      token: null,
      nowIso: "2026-06-18T00:00:00.000Z",
      nowMs: Date.parse("2026-06-18T00:00:00.000Z"),
    };
    await expect(binanceAdapter.buildHistory!(ctx)).rejects.toThrow();
  });
});
