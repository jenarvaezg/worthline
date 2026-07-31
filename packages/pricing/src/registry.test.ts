import type { PriceSource } from "@worthline/domain";
import {
  RETIRED_INVESTMENT_PRICE_PROVIDERS,
  SELECTABLE_INVESTMENT_PRICE_PROVIDERS,
} from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAndCachePrice, type PriceProvider } from "./index";
import {
  fallbackChains,
  fetchPriceNow,
  fetchWithFallback,
  isRegisteredSource,
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
    expect(resolveProvider("ecb")).toBe(providerRegistry.ecb);
  });

  it("a retired source is NOT registered — Stooq answers every symbol with an anti-bot page (#1354)", () => {
    expect(Object.keys(providerRegistry)).not.toContain("stooq");
    expect(isRegisteredSource("stooq")).toBe(false);
    expect(isRegisteredSource("yahoo")).toBe(true);
  });

  it("declares no fallback chain today: the only one pointed at the retired Stooq", () => {
    expect(fallbackChains).toEqual({});
  });

  it("keeps the two definitions of 'retired' in step: retired ⇔ absent from the registry", () => {
    // The domain says WHICH providers are retired (`RETIRED_…`, a data fact the
    // pickers read); pricing decides by REGISTRY ABSENCE. Nothing links them, so
    // this is the tripwire: retiring a provider in one place only would either
    // leave a dead provider selectable or route a live one to the retired stub.
    for (const provider of RETIRED_INVESTMENT_PRICE_PROVIDERS) {
      expect(isRegisteredSource(provider)).toBe(false);
    }
    for (const provider of SELECTABLE_INVESTMENT_PRICE_PROVIDERS) {
      expect(isRegisteredSource(provider)).toBe(true);
    }
  });
});

describe("runFallbackChain", () => {
  it("returns the primary result when the primary succeeds (no fallback consulted)", async () => {
    const primary = fakeProvider("yahoo", { price: "10", currency: "EUR" });
    const fallback = fakeProvider("coingecko", { price: "99", currency: "EUR" });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({ price: "10", currency: "EUR" });
    expect(fallback.fetchPrice).not.toHaveBeenCalled();
  });

  it("walks to the declared fallback on null and stamps the actual deliverer as source", async () => {
    const primary = fakeProvider("yahoo", null);
    const fallback = fakeProvider("coingecko", { price: "4.25", currency: "EUR" });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({ price: "4.25", currency: "EUR", source: "coingecko" });
  });

  it("walks to the declared fallback on a provider failure, returning the rescue", async () => {
    const primary = fakeProvider("yahoo", { failed: true, reason: "boom" });
    const fallback = fakeProvider("coingecko", { price: "4.25", currency: "EUR" });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({ price: "4.25", currency: "EUR", source: "coingecko" });
  });

  it("returns a chain failure reason naming every provider when every link fails", async () => {
    const primary = fakeProvider("yahoo", null);
    const fallback = fakeProvider("coingecko", {
      failed: true,
      reason: "El proveedor respondió con un error (404)",
    });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    // A 404 on the closing leg is a permanent miss: transient=false so the
    // cache layer records a failed row instead of preserving a stale price.
    expect(result).toEqual({
      failed: true,
      reason: "Yahoo: sin cotización; CoinGecko: error (404)",
      transient: false,
    });
  });

  it("classifies a double transient outage (both legs 503) as transient — the composite reason string must not be re-parsed", async () => {
    const primary = fakeProvider("yahoo", {
      failed: true,
      reason: "El proveedor respondió con un error (503)",
    });
    const fallback = fakeProvider("coingecko", {
      failed: true,
      reason: "El proveedor respondió con un error (503)",
    });

    const result = await runFallbackChain(primary, [fallback], baseCtx);

    expect(result).toEqual({
      failed: true,
      reason: "Yahoo: error (503); CoinGecko: error (503)",
      transient: true,
    });
  });

  it("a primary with NO declared fallback that fails names the provider", async () => {
    const primary = fakeProvider("finect", { failed: true, reason: "not found" });

    const result = await runFallbackChain(primary, [], baseCtx);

    expect(result).toEqual({
      failed: true,
      reason: "Finect: not found",
      transient: true,
    });
  });

  it("respects a custom chain ORDER (reordering is a data change, not a body edit)", async () => {
    const primary = fakeProvider("yahoo", null);
    const first = fakeProvider("coingecko", { price: "1", currency: "EUR" });
    const second = fakeProvider("finect", { price: "2", currency: "EUR" });

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
    delete fallbackChains.yahoo;
  });

  it("applies a chain declared as DATA in the registry (extending is one edit here)", async () => {
    // No chain ships today (#1354 retired the Stooq rescue), so this declares one
    // between two live sources to prove the policy seam still routes rescues.
    fallbackChains.yahoo = ["coingecko"];
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ "san-token": { eur: 4.25 } }),
      } as Response);

    const result = await fetchWithFallback("yahoo", { ...baseCtx, symbol: "san-token" });

    expect(result).toMatchObject({ price: "4.25", currency: "EUR", source: "coingecko" });
  });

  it("a Yahoo miss is a miss: with no chain declared there is nothing to rescue it", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    const result = await fetchWithFallback("yahoo", baseCtx);

    expect(result).toMatchObject({ failed: true, reason: "Yahoo: sin cotización" });
    // Exactly one request: the retired provider is not consulted behind Yahoo.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("the bare Yahoo provider does not rescue itself (rescue is policy, not body)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);

    const result = await fetchAndCachePrice(resolveProvider("yahoo"), baseCtx);

    expect(result.freshnessState).toBe("failed");
    expect(result.source).toBe("yahoo");
  });
});

describe("fetchPriceNow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete fallbackChains.yahoo;
  });

  it("returns a FetchedPrice when the primary source delivers (source stamped to the primary)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { currency: "EUR", regularMarketPrice: 12.34 },
              timestamp: [Math.floor(Date.parse("2024-01-15T12:00:00Z") / 1000)],
              indicators: { quote: [{ close: [12.34] }] },
            },
          ],
        },
      }),
    } as Response);

    const result = await fetchPriceNow("yahoo", baseCtx);

    expect(result).toMatchObject({ price: "12.34", currency: "EUR", source: "yahoo" });
  });

  it("exercises a declared chain end to end, stamping the rescuing source", async () => {
    fallbackChains.yahoo = ["coingecko"];
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ "san-token": { eur: 4.25 } }),
      } as Response);

    const result = await fetchPriceNow("yahoo", { ...baseCtx, symbol: "san-token" });

    expect(result).toMatchObject({
      price: "4.25",
      currency: "EUR",
      source: "coingecko",
    });
  });

  it("collapses a total miss (every link fails) to null", async () => {
    fallbackChains.yahoo = ["coingecko"];
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    const result = await fetchPriceNow("yahoo", baseCtx);

    expect(result).toBeNull();
  });

  it("never throws: a provider that rejects degrades to null", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    // yahoo has no declared fallback, so the rejection is the whole chain.
    await expect(fetchPriceNow("yahoo", baseCtx)).resolves.toBeNull();
  });
});
