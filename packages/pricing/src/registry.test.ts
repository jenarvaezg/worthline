import type { PriceSource } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAndCachePrice, type PriceProvider } from "./index";
import {
  fetchPriceNow,
  fetchWithFallback,
  providerRegistry,
  resolveProvider,
  runFallbackChain,
} from "./registry";

const baseCtx = {
  assetId: "asset-1",
  currency: "EUR",
  nowIso: "2024-01-15T12:00:00.000Z",
  symbol: "SAN.MC",
};

/** A controllable provider for asserting policy behaviour at the seam. */
function fakeProvider(
  name: PriceSource,
  result: Awaited<ReturnType<PriceProvider["fetchPrice"]>>,
): PriceProvider {
  return { name, fetchPrice: vi.fn().mockResolvedValue(result) };
}

describe("providerRegistry", () => {
  it("is the single resolution point: every wired source resolves to a provider whose name matches the key", () => {
    for (const [name, provider] of Object.entries(providerRegistry)) {
      expect(provider.name).toBe(name);
    }
  });

  it("resolveProvider returns the registered provider for a source", () => {
    expect(resolveProvider("yahoo")).toBe(providerRegistry.yahoo);
    expect(resolveProvider("stooq")).toBe(providerRegistry.stooq);
    expect(resolveProvider("ecb")).toBe(providerRegistry.ecb);
  });
});

describe("runFallbackChain", () => {
  it("returns the primary result when the primary succeeds (no fallback consulted)", async () => {
    const primary = fakeProvider("yahoo", { price: "10", currency: "EUR" });
    const fallback = fakeProvider("stooq", { price: "99", currency: "EUR" });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({ price: "10", currency: "EUR" });
    expect(fallback.fetchPrice).not.toHaveBeenCalled();
  });

  it("walks to the declared fallback on null and stamps the actual deliverer as source", async () => {
    const primary = fakeProvider("yahoo", null);
    const fallback = fakeProvider("stooq", { price: "4.25", currency: "EUR" });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({ price: "4.25", currency: "EUR", source: "stooq" });
  });

  it("walks to the declared fallback on a provider failure, returning the rescue", async () => {
    const primary = fakeProvider("yahoo", { failed: true, reason: "boom" });
    const fallback = fakeProvider("stooq", { price: "4.25", currency: "EUR" });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({ price: "4.25", currency: "EUR", source: "stooq" });
  });

  it("returns the LAST failure/null verbatim when every link fails", async () => {
    const primary = fakeProvider("yahoo", null);
    const fallback = fakeProvider("stooq", { failed: true, reason: "no quote" });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({ failed: true, reason: "no quote" });
  });

  it("a primary with NO declared fallback that fails stays failed", async () => {
    const primary = fakeProvider("finect", { failed: true, reason: "not found" });

    const result = await runFallbackChain(primary, [], baseCtx);

    expect(result).toEqual({ failed: true, reason: "not found" });
  });

  it("respects a custom chain ORDER (reordering is a data change, not a body edit)", async () => {
    const primary = fakeProvider("yahoo", null);
    const first = fakeProvider("coingecko", { price: "1", currency: "EUR" });
    const second = fakeProvider("stooq", { price: "2", currency: "EUR" });

    const result = await runFallbackChain(primary, [first, second], baseCtx);

    expect(result).toEqual({ price: "1", currency: "EUR", source: "coingecko" });
    expect(second.fetchPrice).not.toHaveBeenCalled();
  });
});

describe("fetchWithFallback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the registry's declared Yahoo→Stooq chain when Yahoo has no price", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2024-01-15,16:00:00,4.10,4.30,4.05,4.25,55000000";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => csv } as Response);

    const result = await fetchWithFallback("yahoo", baseCtx);

    expect(result).toMatchObject({ price: "4.25", currency: "EUR", source: "stooq" });
  });

  it("a source with no declared chain (stooq) is fetched alone — no rescue", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        "Symbol,Date,Time,Open,High,Low,Close,Volume\nVUSA,2026-06-09,16:00:00,80,81,79,80.50,1234",
    } as Response);

    const result = await fetchWithFallback("stooq", { ...baseCtx, symbol: "VUSA.L" });

    expect(result).toMatchObject({ price: "80.50", currency: "EUR" });
  });

  it("the bare Yahoo provider no longer rescues itself (rescue is policy, not body)", async () => {
    // A single not-ok Yahoo response yields a failed AssetPrice stamped "yahoo":
    // the provider does NOT reach for Stooq on its own anymore.
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);

    const result = await fetchAndCachePrice(resolveProvider("yahoo"), baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.source).toBe("yahoo");
  });

  it("the rescue is recorded as source 'stooq' only through the fallback runner", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2024-01-15,16:00:00,4.10,4.30,4.05,4.25,55000000";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => csv } as Response);

    const rescued = await fetchWithFallback("yahoo", baseCtx);

    expect(rescued).toMatchObject({ source: "stooq" });
  });
});

describe("fetchPriceNow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a FetchedPrice when the primary source delivers (source stamped to the primary)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: { result: [{ meta: { currency: "EUR", regularMarketPrice: 12.34 } }] },
      }),
    } as Response);

    const result = await fetchPriceNow("yahoo", baseCtx);

    expect(result).toMatchObject({ price: "12.34", currency: "EUR", source: "yahoo" });
  });

  it("exercises the fallback chain: a Yahoo miss is rescued by Stooq, stamped 'stooq'", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2024-01-15,16:00:00,4.10,4.30,4.05,4.25,55000000";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => csv } as Response);

    const result = await fetchPriceNow("yahoo", baseCtx);

    expect(result).toMatchObject({ price: "4.25", currency: "EUR", source: "stooq" });
  });

  it("collapses a total miss (every link fails) to null", async () => {
    // Yahoo not-ok then Stooq not-ok: the whole chain misses.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: false } as Response);

    const result = await fetchPriceNow("yahoo", baseCtx);

    expect(result).toBeNull();
  });

  it("never throws: a provider that rejects degrades to null", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    // stooq has no declared fallback, so the rejection is the whole chain.
    await expect(fetchPriceNow("stooq", baseCtx)).resolves.toBeNull();
  });
});
