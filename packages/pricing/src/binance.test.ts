/**
 * Binance API client — auth + spot balances (ADR 0021).
 *
 * Binance SIGNED endpoints authenticate by signing the query string with
 * HMAC-SHA256 over the API secret (no token to mint or cache, unlike Numista's
 * OAuth). These tests pin the signature, the signed request shape, and the
 * balance parsing against a mocked `fetch`, the way the Numista/CoinGecko tests do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSpotBalances, signQuery } from "./binance";

const creds = { apiKey: "KEY", apiSecret: "test-secret" };

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe("signQuery — HMAC-SHA256 over the API secret", () => {
  it("produces the canonical hex signature for a known vector", () => {
    // Pinned against `crypto.createHmac('sha256', secret).update(query)`.
    expect(signQuery("timestamp=1700000000000", "test-secret")).toBe(
      "dccf2651b1d8329665bfddb0798eccd4650d986a9cfe5547b2f5822131e7620b",
    );
  });

  it("is deterministic and a 64-char hex digest", () => {
    const sig = signQuery("symbol=BTCEUR&timestamp=1", "test-secret");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signQuery("symbol=BTCEUR&timestamp=1", "test-secret")).toBe(sig);
  });
});

describe("getSpotBalances — signed GET /api/v3/account", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs the timestamped query, sends the API key header, and parses balances", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        balances: [
          { asset: "BTC", free: "0.50000000", locked: "0.00000000" },
          { asset: "ETH", free: "1.00000000", locked: "0.50000000" },
        ],
      }),
    );

    const balances = await getSpotBalances(creds, { nowMs: 1_700_000_000_000 });

    // The signed query is `timestamp=<nowMs>` and the signature is appended.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v3/account?timestamp=1700000000000");
    expect(url).toContain(
      "signature=dccf2651b1d8329665bfddb0798eccd4650d986a9cfe5547b2f5822131e7620b",
    );
    expect((init as RequestInit).headers).toMatchObject({ "X-MBX-APIKEY": "KEY" });

    // Spot balance per asset is free + locked-in-orders (both are spot holdings).
    expect(balances).toEqual([
      { asset: "BTC", wallet: "spot", balance: "0.5" },
      { asset: "ETH", wallet: "spot", balance: "1.5" },
    ]);
  });

  it("drops dust/zero balances so they never become positions", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        balances: [
          { asset: "BTC", free: "0.5", locked: "0" },
          { asset: "GAS", free: "0", locked: "0" },
        ],
      }),
    );

    const balances = await getSpotBalances(creds, { nowMs: 1 });
    expect(balances).toEqual([{ asset: "BTC", wallet: "spot", balance: "0.5" }]);
  });

  it("throws a Binance-tagged error on a non-2xx (bad key / outage)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await expect(getSpotBalances(creds, { nowMs: 1 })).rejects.toThrow(/Binance/);
  });
});
