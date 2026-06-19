/**
 * Binance API client — auth + spot balances (ADR 0021).
 *
 * Binance SIGNED endpoints authenticate by signing the query string with
 * HMAC-SHA256 over the API secret (no token to mint or cache, unlike Numista's
 * OAuth). These tests pin the signature, the signed request shape, and the
 * balance parsing against a mocked `fetch`, the way the Numista/CoinGecko tests do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAccountSnapshots,
  getAllBalances,
  getFlexibleEarnBalances,
  getFundingBalances,
  getLockedEarnBalances,
  getSpotBalances,
  signQuery,
} from "./binance";

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

describe("base URL override — WORTHLINE_BINANCE_BASE_URL (e2e / self-host seam)", () => {
  const ORIGINAL = process.env.WORTHLINE_BINANCE_BASE_URL;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL === undefined) delete process.env.WORTHLINE_BINANCE_BASE_URL;
    else process.env.WORTHLINE_BINANCE_BASE_URL = ORIGINAL;
  });

  it("routes signed calls at the overridden host when the env var is set", async () => {
    process.env.WORTHLINE_BINANCE_BASE_URL = "http://127.0.0.1:9931";
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ balances: [] }));
    await getSpotBalances(creds, { nowMs: 1 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:9931\/api\/v3\/account/);
  });

  it("defaults to the real Binance host when the env var is absent", async () => {
    delete process.env.WORTHLINE_BINANCE_BASE_URL;
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ balances: [] }));
    await getSpotBalances(creds, { nowMs: 1 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/api\.binance\.com\/api\/v3\/account/);
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

describe("getFundingBalances — signed POST /sapi/v1/asset/get-funding-asset", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs a POSTed timestamp, sums free+locked+freeze+withdrawing, and tags wallet funding", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      okJson([
        {
          asset: "BTC",
          free: "0.10000000",
          locked: "0.20000000",
          freeze: "0.30000000",
          withdrawing: "0.40000000",
        },
        { asset: "USDT", free: "100.00000000" },
      ]),
    );

    const balances = await getFundingBalances(creds, { nowMs: 1_700_000_000_000 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/sapi/v1/asset/get-funding-asset?timestamp=1700000000000");
    expect(url).toContain(
      "signature=dccf2651b1d8329665bfddb0798eccd4650d986a9cfe5547b2f5822131e7620b",
    );
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ "X-MBX-APIKEY": "KEY" });

    // Funding balance = free + locked + freeze + withdrawing (all owned; an in-flight
    // withdrawal hasn't left the account yet). Missing buckets count as 0.
    expect(balances).toEqual([
      { asset: "BTC", wallet: "funding", balance: "1" }, // 0.1 + 0.2 + 0.3 + 0.4
      { asset: "USDT", wallet: "funding", balance: "100" },
    ]);
  });

  it("drops zero balances so they never become positions", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okJson([
        { asset: "BTC", free: "0.5", locked: "0", freeze: "0" },
        { asset: "DUST", free: "0", locked: "0", freeze: "0" },
      ]),
    );

    const balances = await getFundingBalances(creds, { nowMs: 1 });
    expect(balances).toEqual([{ asset: "BTC", wallet: "funding", balance: "0.5" }]);
  });

  it("throws a Binance-tagged error on a non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await expect(getFundingBalances(creds, { nowMs: 1 })).rejects.toThrow(/Binance/);
  });
});

describe("getFlexibleEarnBalances — signed GET /sapi/v1/simple-earn/flexible/position", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses totalAmount per row and tags wallet flexible-earn", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        rows: [
          { asset: "USDT", totalAmount: "500.00000000" },
          { asset: "ETH", totalAmount: "1.50000000" },
        ],
        total: 2,
      }),
    );

    const balances = await getFlexibleEarnBalances(creds, { nowMs: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/sapi/v1/simple-earn/flexible/position?");
    expect(url).toContain("size=100");
    expect((init as RequestInit).headers).toMatchObject({ "X-MBX-APIKEY": "KEY" });

    expect(balances).toEqual([
      { asset: "USDT", wallet: "flexible-earn", balance: "500" },
      { asset: "ETH", wallet: "flexible-earn", balance: "1.5" },
    ]);
  });

  it("drops zero balances so they never become positions", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        rows: [
          { asset: "USDT", totalAmount: "500" },
          { asset: "ZERO", totalAmount: "0" },
        ],
        total: 2,
      }),
    );

    const balances = await getFlexibleEarnBalances(creds, { nowMs: 1 });
    expect(balances).toEqual([
      { asset: "USDT", wallet: "flexible-earn", balance: "500" },
    ]);
  });

  it("throws a Binance-tagged error on a non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await expect(getFlexibleEarnBalances(creds, { nowMs: 1 })).rejects.toThrow(/Binance/);
  });
});

describe("getLockedEarnBalances — signed GET /sapi/v1/simple-earn/locked/position", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses amount per row and tags wallet locked-earn (term-locked rung origin)", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        rows: [
          { asset: "ETH", amount: "3.00000000" },
          { asset: "DOT", amount: "120.00000000" },
        ],
        total: 2,
      }),
    );

    const balances = await getLockedEarnBalances(creds, { nowMs: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/sapi/v1/simple-earn/locked/position?");
    expect(url).toContain("size=100");
    expect((init as RequestInit).headers).toMatchObject({ "X-MBX-APIKEY": "KEY" });

    expect(balances).toEqual([
      { asset: "ETH", wallet: "locked-earn", balance: "3" },
      { asset: "DOT", wallet: "locked-earn", balance: "120" },
    ]);
  });

  it("drops zero balances so they never become positions", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        rows: [
          { asset: "ETH", amount: "3" },
          { asset: "ZERO", amount: "0" },
        ],
        total: 2,
      }),
    );

    const balances = await getLockedEarnBalances(creds, { nowMs: 1 });
    expect(balances).toEqual([{ asset: "ETH", wallet: "locked-earn", balance: "3" }]);
  });

  it("throws a Binance-tagged error on a non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await expect(getLockedEarnBalances(creds, { nowMs: 1 })).rejects.toThrow(/Binance/);
  });
});

describe("getAccountSnapshots — signed GET /sapi/v1/accountSnapshot (daily SPOT)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs type=SPOT&limit=30, sends the key header, and derives a UTC dateKey per snapshot", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        snapshotVos: [
          {
            // 2026-03-01T00:00:00Z
            updateTime: Date.UTC(2026, 2, 1),
            data: {
              balances: [
                { asset: "BTC", free: "0.50000000", locked: "0.00000000" },
                { asset: "ETH", free: "1.00000000", locked: "0.50000000" },
              ],
            },
          },
        ],
      }),
    );

    const snapshots = await getAccountSnapshots(creds, { nowMs: 1_700_000_000_000 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/sapi/v1/accountSnapshot?type=SPOT&limit=30");
    expect(url).toContain("timestamp=1700000000000");
    expect(url).toContain(
      "signature=8e3975cdb067fd384efd6c82b2c1aad70ae92488035e8e8945744509b39df11d",
    );
    expect((init as RequestInit).headers).toMatchObject({ "X-MBX-APIKEY": "KEY" });

    // dateKey is the UTC YYYY-MM-DD of updateTime; balance = free + locked.
    expect(snapshots).toEqual([
      {
        dateKey: "2026-03-01",
        balances: [
          { asset: "BTC", balance: "0.5" },
          { asset: "ETH", balance: "1.5" },
        ],
      },
    ]);
  });

  it("zero-filters per-snapshot balances", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okJson({
        snapshotVos: [
          {
            updateTime: Date.UTC(2026, 2, 31),
            data: {
              balances: [
                { asset: "BTC", free: "0.5", locked: "0" },
                { asset: "GAS", free: "0", locked: "0" },
              ],
            },
          },
        ],
      }),
    );

    const snapshots = await getAccountSnapshots(creds, { nowMs: 1 });
    expect(snapshots).toEqual([
      { dateKey: "2026-03-31", balances: [{ asset: "BTC", balance: "0.5" }] },
    ]);
  });

  it("returns an empty list when the account has no snapshots", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ snapshotVos: [] }));
    expect(await getAccountSnapshots(creds, { nowMs: 1 })).toEqual([]);
  });

  it("throws a Binance-tagged error on a non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await expect(getAccountSnapshots(creds, { nowMs: 1 })).rejects.toThrow(/Binance/);
  });
});

describe("getAllBalances — spot + funding + flexible + locked Earn across rungs", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("concatenates all four wallets' balances (market rungs + locked-earn)", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/v3/account")) {
        return okJson({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] });
      }
      if (url.includes("/sapi/v1/asset/get-funding-asset")) {
        return okJson([{ asset: "BTC", free: "0.1", locked: "0", freeze: "0" }]);
      }
      if (url.includes("/sapi/v1/simple-earn/flexible/position")) {
        return okJson({ rows: [{ asset: "USDT", totalAmount: "500" }], total: 1 });
      }
      if (url.includes("/sapi/v1/simple-earn/locked/position")) {
        return okJson({ rows: [{ asset: "ETH", amount: "3" }], total: 1 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const balances = await getAllBalances(creds, { nowMs: 1 });

    expect(balances).toEqual([
      { asset: "BTC", wallet: "spot", balance: "0.5" },
      { asset: "BTC", wallet: "funding", balance: "0.1" },
      { asset: "USDT", wallet: "flexible-earn", balance: "500" },
      { asset: "ETH", wallet: "locked-earn", balance: "3" },
    ]);
  });

  it("drops the spot LD mirror of a flexible-Earn position (no double count)", async () => {
    // Binance lists each Flexible Earn principal a second time in the SPOT account
    // as an `LD`-prefixed mirror token (LDBTC = the flexible-savings BTC). The Earn
    // endpoint already reports that principal under its real symbol on the market
    // rung, so keeping the spot LD line double-counts it. Drop the spot `LD<X>`
    // line only when a flexible-Earn position for `<X>` exists.
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/v3/account")) {
        return okJson({
          balances: [
            { asset: "LDBTC", free: "0.5", locked: "0" }, // mirror of Earn BTC → dropped
            { asset: "LDO", free: "10", locked: "0" }, // real Lido token, no Earn match → kept
            { asset: "ETH", free: "2", locked: "0" }, // plain spot → kept
          ],
        });
      }
      if (url.includes("/sapi/v1/asset/get-funding-asset")) {
        return okJson([]);
      }
      if (url.includes("/sapi/v1/simple-earn/flexible/position")) {
        return okJson({ rows: [{ asset: "BTC", totalAmount: "0.55" }], total: 1 });
      }
      if (url.includes("/sapi/v1/simple-earn/locked/position")) {
        return okJson({ rows: [], total: 0 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const balances = await getAllBalances(creds, { nowMs: 1 });

    expect(balances).toEqual([
      { asset: "LDO", wallet: "spot", balance: "10" },
      { asset: "ETH", wallet: "spot", balance: "2" },
      { asset: "BTC", wallet: "flexible-earn", balance: "0.55" },
    ]);
  });

  it("aborts the whole read if one wallet endpoint fails (spot work is discarded)", async () => {
    // A read-only key/transient outage that fails funding must not partial-commit:
    // getAllBalances rejects, and the action's catch leaves positions untouched.
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/v3/account")) {
        return okJson({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] });
      }
      if (url.includes("/sapi/v1/asset/get-funding-asset")) {
        return { ok: false, status: 401 } as Response;
      }
      return okJson({ rows: [], total: 0 });
    });

    await expect(getAllBalances(creds, { nowMs: 1 })).rejects.toThrow(/Binance/);
  });
});
