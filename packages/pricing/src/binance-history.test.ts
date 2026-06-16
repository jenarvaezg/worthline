/**
 * Binance monthly-history reconstruction (PRD #245, S5, ADR 0021).
 *
 * Derives the `BinanceHistoryCurve` the pure domain builder values: from Binance's
 * cheap daily SPOT snapshots it takes each calendar month's LATEST snapshot as the
 * month-end balance, resolves each symbol → CoinGecko id, and fetches each id's
 * daily EUR price series over the covered range (deduped per id). An unmapped
 * symbol gets no price entries (→ valued 0 downstream); a CoinGecko miss → empty.
 * Every external read is injected, so this is testable without the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchCoinGeckoHistoryEur, reconstructBinanceHistory } from "./binance-history";

describe("reconstructBinanceHistory — snapshots → month-end balances + daily prices", () => {
  it("takes each month's LATEST snapshot as the month-end balance, per asset", async () => {
    const calls: { id: string; from: string; to: string }[] = [];
    const curve = await reconstructBinanceHistory({
      accountSnapshots: async () => [
        // March: two snapshots — the later one (03-31) is the month-end.
        { dateKey: "2026-03-10", balances: [{ asset: "BTC", balance: "0.4" }] },
        { dateKey: "2026-03-31", balances: [{ asset: "BTC", balance: "0.5" }] },
        // April: a single snapshot.
        { dateKey: "2026-04-30", balances: [{ asset: "BTC", balance: "0.6" }] },
      ],
      historicalPriceEur: async (id, from, to) => {
        calls.push({ id, from, to });
        return new Map([
          ["2026-03-31", "50000"],
          ["2026-04-30", "55000"],
        ]);
      },
    });

    expect(curve.monthEndBalances.get("BTC")).toEqual(
      new Map([
        ["2026-03", "0.5"], // 03-31 wins over 03-10
        ["2026-04", "0.6"],
      ]),
    );
    // BTC → bitcoin resolved once, fetched over the covered date range.
    expect(calls).toEqual([{ id: "bitcoin", from: "2026-03-10", to: "2026-04-30" }]);
    expect(curve.dailyPriceBySymbol.get("BTC")).toEqual(
      new Map([
        ["2026-03-31", "50000"],
        ["2026-04-30", "55000"],
      ]),
    );
  });

  it("assembles a multi-symbol curve, fetching one daily series per CoinGecko id", async () => {
    const fetched: string[] = [];
    const curve = await reconstructBinanceHistory({
      accountSnapshots: async () => [
        {
          dateKey: "2026-03-31",
          balances: [
            { asset: "BTC", balance: "0.5" },
            { asset: "ETH", balance: "2" },
          ],
        },
      ],
      historicalPriceEur: async (id) => {
        fetched.push(id);
        return new Map([["2026-03-31", id === "bitcoin" ? "50000" : "2000"]]);
      },
    });

    expect(fetched.sort()).toEqual(["bitcoin", "ethereum"]);
    expect(curve.monthEndBalances.get("BTC")?.get("2026-03")).toBe("0.5");
    expect(curve.monthEndBalances.get("ETH")?.get("2026-03")).toBe("2");
    expect(curve.dailyPriceBySymbol.get("BTC")?.get("2026-03-31")).toBe("50000");
    expect(curve.dailyPriceBySymbol.get("ETH")?.get("2026-03-31")).toBe("2000");
  });

  it("an UNMAPPED symbol contributes a month-end balance but NO price entries", async () => {
    const fetched: string[] = [];
    const curve = await reconstructBinanceHistory({
      accountSnapshots: async () => [
        {
          dateKey: "2026-03-31",
          balances: [
            { asset: "BTC", balance: "0.5" },
            { asset: "WAGMI", balance: "100" },
          ],
        },
      ],
      historicalPriceEur: async (id) => {
        fetched.push(id);
        return new Map([["2026-03-31", "50000"]]);
      },
    });

    // WAGMI resolves to no CoinGecko id → never fetched → no price series.
    expect(fetched).toEqual(["bitcoin"]);
    expect(curve.monthEndBalances.get("WAGMI")?.get("2026-03")).toBe("100");
    expect(curve.dailyPriceBySymbol.has("WAGMI")).toBe(false);
  });

  it("a CoinGecko miss leaves the symbol with an empty price series (still a balance)", async () => {
    const curve = await reconstructBinanceHistory({
      accountSnapshots: async () => [
        { dateKey: "2026-03-31", balances: [{ asset: "BTC", balance: "0.5" }] },
      ],
      historicalPriceEur: async () => new Map(), // outage / no data
    });

    expect(curve.monthEndBalances.get("BTC")?.get("2026-03")).toBe("0.5");
    expect(curve.dailyPriceBySymbol.get("BTC")?.size).toBe(0);
  });

  it("an empty snapshot list yields an empty curve", async () => {
    const curve = await reconstructBinanceHistory({
      accountSnapshots: async () => [],
      historicalPriceEur: async () => new Map(),
    });
    expect(curve.monthEndBalances.size).toBe(0);
    expect(curve.dailyPriceBySymbol.size).toBe(0);
  });

  it("a snapshot dropping an asset later in the month sets that month's end to absent", async () => {
    // BTC present 03-10 then gone by 03-31 → the month-end (latest snapshot) has no BTC.
    const curve = await reconstructBinanceHistory({
      accountSnapshots: async () => [
        { dateKey: "2026-03-10", balances: [{ asset: "BTC", balance: "0.4" }] },
        { dateKey: "2026-03-31", balances: [{ asset: "ETH", balance: "2" }] },
      ],
      historicalPriceEur: async (id) =>
        new Map([["2026-03-31", id === "ethereum" ? "2000" : "50000"]]),
    });

    expect(curve.monthEndBalances.get("BTC")?.has("2026-03")).toBeFalsy();
    expect(curve.monthEndBalances.get("ETH")?.get("2026-03")).toBe("2");
  });
});

describe("fetchCoinGeckoHistoryEur — base URL override (e2e / self-host seam)", () => {
  const ORIGINAL = process.env.WORTHLINE_COINGECKO_BASE_URL;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL === undefined) delete process.env.WORTHLINE_COINGECKO_BASE_URL;
    else process.env.WORTHLINE_COINGECKO_BASE_URL = ORIGINAL;
  });

  it("requests the overridden host when WORTHLINE_COINGECKO_BASE_URL is set", async () => {
    process.env.WORTHLINE_COINGECKO_BASE_URL = "http://127.0.0.1:9931/coingecko/api/v3";
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices: [] }),
    } as Response);
    await fetchCoinGeckoHistoryEur("bitcoin", 0, 1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(
      /^http:\/\/127\.0\.0\.1:9931\/coingecko\/api\/v3\/coins\/bitcoin\/market_chart\/range/,
    );
  });

  it("defaults to the real CoinGecko host when the env var is absent", async () => {
    delete process.env.WORTHLINE_COINGECKO_BASE_URL;
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices: [] }),
    } as Response);
    await fetchCoinGeckoHistoryEur("bitcoin", 0, 1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(
      /^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/bitcoin\/market_chart\/range/,
    );
  });
});

describe("fetchCoinGeckoHistoryEur — /market_chart/range → dateKey→price (last wins)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the EUR range and parses prices into a dateKey→price map", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        prices: [
          [Date.UTC(2026, 2, 31, 0, 0), 49000],
          [Date.UTC(2026, 2, 31, 23, 0), 50000], // later same-day point wins
          [Date.UTC(2026, 3, 30, 12, 0), 55000],
        ],
      }),
    } as Response);

    const map = await fetchCoinGeckoHistoryEur(
      "bitcoin",
      Date.UTC(2026, 2, 1),
      Date.UTC(2026, 3, 30),
    );

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/coins/bitcoin/market_chart/range");
    expect(url).toContain("vs_currency=eur");
    expect(url).toContain(`from=${Math.floor(Date.UTC(2026, 2, 1) / 1000)}`);
    expect(url).toContain(`to=${Math.floor(Date.UTC(2026, 3, 30) / 1000)}`);

    expect(map).toEqual(
      new Map([
        ["2026-03-31", "50000"],
        ["2026-04-30", "55000"],
      ]),
    );
  });

  it("clamps the `to` upper bound to nowIso so it never requests the future", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices: [] }),
    } as Response);

    const now = "2026-03-15T00:00:00.000Z";
    await fetchCoinGeckoHistoryEur(
      "bitcoin",
      Date.UTC(2026, 2, 1),
      Date.UTC(2026, 3, 30), // runs past `now`
      now,
    );

    const [url] = fetchMock.mock.calls[0]!;
    // `to` is capped at nowIso, not the requested (future) toMs.
    expect(url).toContain(`to=${Math.floor(Date.parse(now) / 1000)}`);
    expect(url).not.toContain(`to=${Math.floor(Date.UTC(2026, 3, 30) / 1000)}`);
  });

  it("returns an empty map on a non-OK response (never throws)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    expect(await fetchCoinGeckoHistoryEur("bitcoin", 0, 1)).toEqual(new Map());
  });

  it("returns an empty map on a thrown network error (never throws)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    expect(await fetchCoinGeckoHistoryEur("bitcoin", 0, 1)).toEqual(new Map());
  });

  it("returns an empty map when the response carries no prices", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);
    expect(await fetchCoinGeckoHistoryEur("bitcoin", 0, 1)).toEqual(new Map());
  });
});
