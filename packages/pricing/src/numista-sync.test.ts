/**
 * Numista sync orchestration (PRD #160 / #163, ADR 0017).
 *
 * Ties the readers + resolvers into the position drafts a sync persists: for each
 * collected coin, resolve its metal value (composition × weight × spot) and its
 * numismatic estimate (per grade), leaving max(metal, numismatic) to the domain.
 * Dependencies are injected so the orchestration is tested without the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchMetalSpotEur, syncNumistaCollection } from "./numista-sync";
import type { NumistaCollectedItem } from "./numista";

const NOW = "2026-06-15T12:00:00.000Z";

const SILVER_EAGLE: NumistaCollectedItem = {
  id: 1,
  quantity: 1,
  type: { id: 1493, title: "1 Dollar American Silver Eagle" },
  issue: { id: 32723 },
  grade: "unc",
};

const PESETAS: NumistaCollectedItem = {
  id: 2,
  quantity: 2,
  type: { id: 5678, title: "5 Pesetas Alfonso XII" },
  issue: { id: 99001 },
  grade: "vf",
  price: { value: 40.5, currency: "EUR" },
  acquisition_date: "2019-05-12",
};

function deps(overrides: Partial<Parameters<typeof syncNumistaCollection>[0]> = {}) {
  return {
    listItems: vi.fn(async () => [SILVER_EAGLE, PESETAS]),
    typeDetail: vi.fn(async (typeId: number) =>
      typeId === 1493
        ? { title: "Silver Eagle", compositionText: "Plata 999", weightGrams: 31.103 }
        : { title: "5 Pesetas", compositionText: "Plata 900", weightGrams: 25 },
    ),
    prices: vi.fn(async (typeId: number) =>
      typeId === 1493
        ? { currency: "EUR", prices: [{ grade: "unc", price: 75.585 }] }
        : { currency: "EUR", prices: [{ grade: "vf", price: 12 }] },
    ),
    spotPerOzEur: vi.fn(async () => 28),
    ...overrides,
  };
}

describe("syncNumistaCollection — drafts carry both candidate values", () => {
  it("resolves metal (× qty) and numismatic (× qty) per coin", async () => {
    const drafts = await syncNumistaCollection(deps(), NOW);

    expect(drafts).toHaveLength(2);
    const eagle = drafts.find((d) => d.catalogueId === "1493")!;
    expect(eagle).toMatchObject({
      catalogueId: "1493",
      liquidityTier: "illiquid",
      metal: "silver",
      quantity: 1,
      metalValueMinor: 2797, // 31.103g × .999 / 31.1035 × €28
      numismaticValueMinor: 7558, // 75.585 → 7558, × qty 1
      purchasePriceMinor: null,
      purchaseDate: null,
    });

    const pesetas = drafts.find((d) => d.catalogueId === "5678")!;
    expect(pesetas).toMatchObject({
      quantity: 2,
      metalValueMinor: 4051, // 25g × .900 / 31.1035 × €28 × 2
      numismaticValueMinor: 2400, // 12 → 1200, × qty 2
      purchasePriceMinor: 4050,
      purchaseDate: "2019-05-12",
    });
  });

  it("persists the indefinite coin detail + issue id + numismatic fetched-at", async () => {
    const drafts = await syncNumistaCollection(deps(), NOW);

    const eagle = drafts.find((d) => d.catalogueId === "1493")!;
    expect(eagle).toMatchObject({
      issueId: 32723,
      finenessMillis: 999, // parsed from "Plata 999"
      weightGrams: 31.103,
      numismaticFetchedAt: NOW, // estimate just read → stamps the long-TTL clock
    });
  });

  it("leaves numismatic fetched-at null when the coin has no issue/grade to price", async () => {
    const noIssue: NumistaCollectedItem = {
      id: 7,
      quantity: 1,
      type: { id: 1493, title: "1 Dollar American Silver Eagle" },
      grade: "unc",
      // no `issue` → cannot fetch a per-grade estimate
    };
    const drafts = await syncNumistaCollection(
      deps({ listItems: vi.fn(async () => [noIssue]) }),
      NOW,
    );

    expect(drafts[0]).toMatchObject({ issueId: null, numismaticFetchedAt: null });
  });

  it("dedupes type-detail and spot lookups (request-cap discipline)", async () => {
    const d = deps({ listItems: vi.fn(async () => [SILVER_EAGLE, SILVER_EAGLE]) });

    await syncNumistaCollection(d, NOW);

    expect(d.typeDetail).toHaveBeenCalledTimes(1); // same type → one detail fetch
    expect(d.spotPerOzEur).toHaveBeenCalledTimes(1); // silver spot fetched once
  });

  it("a base-metal coin gets no metal value and never fetches spot", async () => {
    const base: NumistaCollectedItem = {
      id: 3,
      quantity: 1,
      type: { id: 9000, title: "100 Pesetas Franco" },
      issue: { id: 1 },
      grade: "vf",
    };
    const d = deps({
      listItems: vi.fn(async () => [base]),
      typeDetail: vi.fn(async () => ({
        title: "100 Pesetas",
        compositionText: "Cuproníquel",
        weightGrams: 9.25,
      })),
      prices: vi.fn(async () => ({
        currency: "EUR",
        prices: [{ grade: "vf", price: 1.6 }],
      })),
    });

    const drafts = await syncNumistaCollection(d, NOW);

    expect(drafts[0]!.metal).toBeNull();
    expect(drafts[0]!.metalValueMinor).toBeNull();
    expect(drafts[0]!.numismaticValueMinor).toBe(160);
    expect(d.spotPerOzEur).not.toHaveBeenCalled();
  });
});

describe("fetchMetalSpotEur — Stooq (USD/oz) × ECB (EUR/USD)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts the USD spot to EUR via the ECB rate", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nXAGUSD,2026-06-15,12:00,29,31,28,30,1000";
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, text: async () => csv } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dataSets: [{ series: { "0:0:0:0:0": { observations: { "0": [1.1] } } } }],
        }),
      } as Response);

    const eur = await fetchMetalSpotEur("silver", "2026-06-15T12:00:00.000Z");

    // 30 USD/oz × (1 / 1.1) EUR/USD ≈ 27.27
    expect(eur).toBeCloseTo(27.2727, 2);
  });

  it("degrades to null when the spot fetch fails (never throws)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    expect(await fetchMetalSpotEur("gold", "2026-06-15T12:00:00.000Z")).toBeNull();
  });
});
