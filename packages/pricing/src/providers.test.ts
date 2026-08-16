import { readFileSync } from "node:fs";

import type { AssetPrice } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coingeckoProvider } from "./coingecko";
import { finectProvider } from "./finect";
import { fetchAndCachePrice } from "./index";
import { fetchWithFallback } from "./registry";
import { yahooProvider } from "./yahoo";

const finectFixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/finect/${name}`, import.meta.url), "utf8");

const FUND_USD_HTML = finectFixture("fund-usd.html");
const PENSION_PLAN_EUR_HTML = finectFixture("pension-plan-eur.html");
const PRODUCTO_NO_DISPONIBLE_HTML = finectFixture("producto-no-disponible.html");

const baseCtx = {
  assetId: "asset-1",
  currency: "EUR",
  nowIso: "2024-01-15T12:00:00.000Z",
  symbol: "bitcoin",
};

describe("coingeckoProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchPrice returns price and currency on successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 50000 } }),
    } as Response);

    const result = await coingeckoProvider.fetchPrice(baseCtx);

    expect(result).toEqual({ price: "50000", currency: "EUR" });
  });

  it("normalizes the symbol to a lowercase coin id (trims + lowercases)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bitcoin: { eur: 50000 } }),
    } as Response);

    const result = await coingeckoProvider.fetchPrice({
      ...baseCtx,
      symbol: "  Bitcoin  ",
    });

    expect(result).toEqual({ price: "50000", currency: "EUR" });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("ids=bitcoin");
  });

  it("fetchPrice returns null for unknown symbol (empty response object)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await coingeckoProvider.fetchPrice(baseCtx);

    expect(result).toBeNull();
  });

  it("fetchPrice returns null when response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
    } as Response);

    const result = await coingeckoProvider.fetchPrice(baseCtx);

    expect(result).toBeNull();
  });

  describe("WORTHLINE_COINGECKO_API_KEY — demo-key rate-limit headroom", () => {
    const ORIGINAL = process.env.WORTHLINE_COINGECKO_API_KEY;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.WORTHLINE_COINGECKO_API_KEY;
      else process.env.WORTHLINE_COINGECKO_API_KEY = ORIGINAL;
    });

    it("sends the x-cg-demo-api-key header when the key env is set", async () => {
      process.env.WORTHLINE_COINGECKO_API_KEY = "  CG-test-key  ";
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bitcoin: { eur: 50000 } }),
      } as Response);

      await coingeckoProvider.fetchPrice(baseCtx);

      const init = vi.mocked(fetch).mock.calls[0]![1];
      expect(init?.headers).toEqual({ "x-cg-demo-api-key": "CG-test-key" });
    });

    it("sends no demo-key header when the key env is absent", async () => {
      delete process.env.WORTHLINE_COINGECKO_API_KEY;
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bitcoin: { eur: 50000 } }),
      } as Response);

      await coingeckoProvider.fetchPrice(baseCtx);

      const init = vi.mocked(fetch).mock.calls[0]![1];
      expect(init?.headers).toEqual({});
    });
  });
});

describe("yahooProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects undated Yahoo metadata when the price series is empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 123.45,
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({ ...baseCtx, symbol: "SAN.MC" });

    expect(result).toBeNull();
  });

  it("uses dated Yahoo metadata when the price series is empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 21.436,
                regularMarketTime: Math.floor(
                  Date.parse("2026-07-10T19:55:16.000Z") / 1000,
                ),
              },
              indicators: { quote: [{}], adjclose: [{}] },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({
      ...baseCtx,
      nowIso: "2026-07-11T10:00:00.000Z",
      symbol: "JE00B8DFY052.SG",
    });

    expect(result).toEqual({
      price: "21.436",
      currency: "EUR",
      priceDate: "2026-07-10",
    });
  });

  it("rejects stale dated Yahoo metadata when the price series is empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 21.436,
                regularMarketTime: Math.floor(
                  Date.parse("2026-06-01T16:00:00.000Z") / 1000,
                ),
              },
              indicators: { quote: [{}], adjclose: [{}] },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({
      ...baseCtx,
      nowIso: "2026-07-11T10:00:00.000Z",
      symbol: "JE00B8DFY052.SG",
    });

    expect(result).toBeNull();
  });

  it("prefers the latest valid chart close over stale Yahoo metadata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 21.22,
              },
              timestamp: [1781074800, 1781161200, 1781247600, 1781506800],
              indicators: {
                quote: [
                  {
                    close: [
                      40.507999420166016,
                      40.746498107910156,
                      41.500999450683594,
                      null,
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({
      ...baseCtx,
      symbol: "IE0007987708.IR",
    });

    expect(result).toEqual({
      price: "41.50099945",
      currency: "EUR",
      priceDate: "2026-06-12",
    });
  });

  it("returns null for dead Yahoo listings whose latest market date is stale", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: {
                currency: "EUR",
                regularMarketPrice: 20.28,
              },
              timestamp: [1443744000],
              indicators: {
                quote: [{ close: [20.28] }],
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await yahooProvider.fetchPrice({
      ...baseCtx,
      nowIso: "2026-07-02T08:00:00.000Z",
      symbol: "IE00B4ND3602.IR",
    });

    expect(result).toBeNull();
  });

  it("converts non-EUR Yahoo prices to EUR through ECB rates", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  currency: "USD",
                  regularMarketPrice: 100,
                },
                timestamp: [Math.floor(Date.parse("2024-01-15T12:00:00Z") / 1000)],
                indicators: {
                  quote: [{ close: [100] }],
                },
              },
            ],
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dataSets: [
            {
              series: {
                "0:0:0:0:0": {
                  observations: {
                    "0": [1.25],
                  },
                },
              },
            },
          ],
        }),
      } as Response);

    const result = await yahooProvider.fetchPrice({ ...baseCtx, symbol: "AAPL" });

    expect(result).toEqual({ price: "80", currency: "EUR", priceDate: "2024-01-15" });
  });

  // Stooq was Yahoo's declared rescue until #1354 retired it. There is no second
  // market source today, so these pin the honest outcome of a Yahoo miss: a
  // failed row naming Yahoo, with no phantom second leg in the reason.
  it("an undated Yahoo meta quote is a miss, and nothing rescues it", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [{ meta: { currency: "USD", regularMarketPrice: 100 } }],
        },
      }),
    } as Response);

    const result = await fetchAndCachePrice(
      { name: "yahoo", fetchPrice: (ctx) => fetchWithFallback("yahoo", ctx) },
      { ...baseCtx, symbol: "AAPL.US" },
    );

    expect(result.freshnessState).toBe("failed");
    expect(result.source).toBe("yahoo");
    expect(result.staleReason).toBe("Yahoo: sin cotización");
  });

  it("a Yahoo HTTP error names only Yahoo in the failure reason", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);

    const result = await fetchAndCachePrice(
      { name: "yahoo", fetchPrice: (ctx) => fetchWithFallback("yahoo", ctx) },
      { ...baseCtx, symbol: "NOPE.MC" },
    );

    expect(result.freshnessState).toBe("failed");
    expect(result.staleReason).toBe("Yahoo: sin cotización");
  });

  it("a Yahoo request that throws degrades to a failed row, not to another provider", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));

    const result = await fetchAndCachePrice(
      { name: "yahoo", fetchPrice: (ctx) => fetchWithFallback("yahoo", ctx) },
      { ...baseCtx, symbol: "SAN.MC" },
    );

    expect(result.freshnessState).toBe("failed");
    expect(result.source).toBe("yahoo");
  });
});

describe("finectProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const htmlResponse = (html: string) =>
    ({ ok: true, text: async () => html }) as Response;

  it("reads the NAV and its currency from the JSON-LD offer, not the visible text", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(htmlResponse(PENSION_PLAN_EUR_HTML));

    const result = await finectProvider.fetchPrice({ ...baseCtx, symbol: "N5394" });

    // The visible label rounds to 21,64; the offer carries the full NAV.
    expect(result).toEqual({
      price: "21.64353",
      currency: "EUR",
      priceDate: "2026-08-13",
    });
  });

  it("converts a USD fund NAV to EUR instead of labelling dollars as euros (#1357)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(htmlResponse(FUND_USD_HTML))
      // ECB publishes USD per EUR (1.25) → one USD is worth 0.80 EUR.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dataSets: [{ series: { "0:0:0:0:0": { observations: { "0": [1.25] } } } }],
        }),
      } as Response);

    const result = await finectProvider.fetchPrice({
      ...baseCtx,
      symbol: "IE00BDZVHT63-Fidelity_msci_pac_ex_jpn_idx_usd_p_acc",
    });

    expect(result).toEqual({
      price: "6.89688",
      currency: "EUR",
      priceDate: "2026-08-14",
    });
  });

  it("never mistakes URL-encoded page copy for a NAV (the '%20de%20Europa' trap, #1357)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(htmlResponse(FUND_USD_HTML))
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    const result = await finectProvider.fetchPrice({
      ...baseCtx,
      symbol: "IE00BDZVHT63-Fidelity_msci_pac_ex_jpn_idx_usd_p_acc",
    });

    // Without FX there is no honest EUR price: fail transiently rather than
    // fall back to the first "<digits> EUR" in the flattened HTML (that was 20).
    expect(result).toEqual({
      failed: true,
      reason: "No se pudo convertir USD a EUR (tipo de cambio no disponible)",
    });
  });

  it("reports a symbol-not-found failure for the 'Producto no disponible' soft-404 page", async () => {
    // The real soft-404 body is full of URL-encoded state ("%22euribor"), which
    // the old text scrape read as a 22 EUR quote.
    vi.mocked(fetch).mockResolvedValueOnce(htmlResponse(PRODUCTO_NO_DISPONIBLE_HTML));

    const result = await finectProvider.fetchPrice({ ...baseCtx, symbol: "NOPE" });

    expect(result).toEqual({
      failed: true,
      reason: "Símbolo no encontrado en el proveedor",
    });
  });

  it("fails transiently when the product page carries no readable offer", async () => {
    // A layout change is not a dead symbol: keep the cached price alive.
    vi.mocked(fetch).mockResolvedValueOnce(
      htmlResponse(
        "<html><head><title>Myinvestor PP - Finect</title></head><body/></html>",
      ),
    );

    const result = await finectProvider.fetchPrice({ ...baseCtx, symbol: "N5394" });

    expect(result).toEqual({
      failed: true,
      reason: "No se pudo leer la cotización en la página del proveedor",
    });
  });

  it("keeps a prior good price when the page becomes unreadable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      htmlResponse(
        "<html><head><title>Myinvestor PP - Finect</title></head><body/></html>",
      ),
    );
    const prior: AssetPrice = {
      assetId: "asset-1",
      currency: "EUR",
      price: "21.64353",
      source: "finect",
      fetchedAt: "2026-08-13T10:00:00Z",
      freshnessState: "fresh",
    };

    const result = await fetchAndCachePrice(
      finectProvider,
      { ...baseCtx, symbol: "N5394" },
      { prior },
    );

    expect(result.freshnessState).toBe("stale");
    expect(result.price).toBe("21.64353");
  });

  it("reports an HTTP-error failure when Finect responds with a non-2xx status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const result = await finectProvider.fetchPrice({ ...baseCtx, symbol: "N5394" });

    expect(result).toEqual({
      failed: true,
      reason: "El proveedor respondió con un error (503)",
    });
  });
});

describe("fetchAndCachePrice", () => {
  it("preserves the prior good price on a transient failure", async () => {
    const provider = {
      name: "stooq" as const,
      fetchPrice: async () => null,
    };
    const prior: AssetPrice = {
      assetId: "asset-1",
      currency: "EUR",
      price: "42.50",
      source: "stooq",
      fetchedAt: "2026-06-08T10:00:00Z",
      freshnessState: "fresh",
    };

    const result = await fetchAndCachePrice(provider, baseCtx, { prior });

    expect(result.freshnessState).toBe("stale");
    expect(result.price).toBe("42.50");
    expect(result.staleReason).toBe("No price returned");
  });

  it("returns failed AssetPrice when provider returns null", async () => {
    const provider = {
      name: "stooq" as const,
      fetchPrice: async () => null,
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.assetId).toBe("asset-1");
    expect(result.source).toBe("stooq");
    expect(result.staleReason).toBe("No price returned");
  });

  it("surfaces a discriminated provider failure reason as staleReason", async () => {
    const provider = {
      name: "finect" as const,
      fetchPrice: async () => ({
        failed: true as const,
        reason: "Símbolo no encontrado en el proveedor",
      }),
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.staleReason).toBe("Símbolo no encontrado en el proveedor");
    expect(result.source).toBe("finect");
  });

  it("returns failed AssetPrice when provider throws", async () => {
    const provider = {
      name: "coingecko" as const,
      fetchPrice: async (): Promise<null> => {
        throw new Error("Network timeout");
      },
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.staleReason).toBe("Network timeout");
  });

  it("returns fresh AssetPrice on successful fetch", async () => {
    const provider = {
      name: "yahoo" as const,
      fetchPrice: async () => ({
        price: "42.50",
        currency: "EUR",
        priceDate: "2024-01-15",
      }),
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("fresh");
    expect(result.price).toBe("42.50");
    expect(result.currency).toBe("EUR");
    expect(result.priceDate).toBe("2024-01-15");
    expect(result.fetchedAt).toBe(baseCtx.nowIso);
  });

  it("returns failed AssetPrice when provider currency does not match asset currency", async () => {
    const provider = {
      name: "yahoo" as const,
      fetchPrice: async () => ({
        price: "42.50",
        currency: "USD",
      }),
    };

    const result: AssetPrice = await fetchAndCachePrice(provider, baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.currency).toBe("EUR");
    expect(result.price).toBe("0");
    expect(result.staleReason).toBe(
      "La divisa del proveedor (USD) no coincide con la del activo (EUR)",
    );
  });
});
