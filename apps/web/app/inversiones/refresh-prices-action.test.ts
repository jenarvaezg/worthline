/**
 * Tests for refreshPricesAction's honest force-refresh path (#317, ADR 0026).
 *
 * The manual "Actualizar precios" button must refetch EVERY configured asset and
 * record the delivering source — regardless of whether the cached row is still
 * fresh. Before #317 this was achieved by fabricating epoch-dated `stooq` cache
 * rows (`forcedStaleCache`) to defeat the staleness filter. This suite asserts
 * the honest replacement: refresh fetches through the registry's fallback chain
 * and persists the result, with no fake cache rows.
 *
 * Uses the `_store` injection seam with a real in-memory store and a stubbed
 * global `fetch` so the registry actually delivers a price. `redirect` throws
 * `NEXT_REDIRECT` natively; we catch it by digest like statement-actions.test.ts.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { fixedClock } from "@worthline/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { refreshPricesAction } from "./actions";

const NOW = "2026-06-18T10:00:00.000Z";

function refreshForm(): FormData {
  const fd = new FormData();
  fd.set("currentUrl", "/patrimonio");
  return fd;
}

async function seedEtf(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "etf",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "ETF",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "yahoo",
    providerSymbol: "SAN.MC",
  });
}

async function run(store: WorthlineStore): Promise<string> {
  try {
    await refreshPricesAction(refreshForm(), store, undefined, fixedClock(NOW));
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

function yahooQuote(price: number) {
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            meta: { currency: "EUR", regularMarketPrice: price },
            timestamp: [Math.floor(Date.parse(NOW) / 1000)],
            indicators: { quote: [{ close: [price] }] },
          },
        ],
      },
    }),
  } as Response;
}

describe("refreshPricesAction honest force-refresh (#317)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches the configured asset and records the delivering source — even when the cached row is already fresh", async () => {
    const store = await createInMemoryStore();
    await seedEtf(store);
    // A genuinely FRESH cached row: under staleness rules it would NOT be
    // refreshed. Manual refresh must override that and refetch anyway.
    await store.operations.upsertPrice({
      assetId: "etf",
      currency: "EUR",
      fetchedAt: NOW,
      freshnessState: "fresh",
      price: "100",
      source: "yahoo",
    });
    vi.mocked(fetch).mockResolvedValueOnce(yahooQuote(12.34));

    const digest = await run(store);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(digest).toContain("ok=prices_refreshed");
    expect(digest).toContain("updated=1");

    const persisted = await store.operations.readPriceCache("etf");
    expect(persisted).toMatchObject({
      assetId: "etf",
      price: "12.34",
      source: "yahoo",
      freshnessState: "fresh",
    });
  });

  test("records the rescuing source when the primary misses and a fallback delivers", async () => {
    const store = await createInMemoryStore();
    await seedEtf(store);
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nSAN,2026-06-18,16:00:00,4.10,4.30,4.05,4.25,1234";
    // Yahoo not-ok, then the registry's Yahoo→Stooq chain rescues via Stooq.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => csv } as Response);

    await run(store);

    const persisted = await store.operations.readPriceCache("etf");
    expect(persisted).toMatchObject({ price: "4.25", source: "stooq" });
  });
});
