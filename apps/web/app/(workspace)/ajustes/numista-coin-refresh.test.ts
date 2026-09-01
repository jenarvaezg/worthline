/**
 * Production wiring of the coin-valuation refresh (PRD #166, ADR 0017).
 *
 * The orchestration and the valuation are unit-tested on their own; what only this
 * seam can show is that the two are actually BOUND — in particular that the pass
 * gets a checkpoint (#1739), the mechanism that keeps a killed pass from re-buying
 * the collection. The Numista/Yahoo network and the store are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The pass itself, stubbed: this test is about what the wiring PASSES to it. */
const { refreshCoinValuations } = vi.hoisted(() => ({
  refreshCoinValuations: vi.fn(
    async (
      _positions: unknown,
      _deps: unknown,
      _options: {
        checkpoint?: { every: number; persist: (updates: unknown[]) => Promise<void> };
      },
    ) => ({ error: null, updates: [] }),
  ),
}));

vi.mock("@worthline/pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@worthline/pricing")>()),
  fetchMetalSpotEur: vi.fn(async () => 28),
  getPrices: vi.fn(async () => null),
  isTokenValid: vi.fn(() => true),
  mintNumistaToken: vi.fn(async () => ({ accessToken: "t", expiresAt: 0 })),
  refreshCoinValuations,
}));

import { REVALUE_CHECKPOINT_COINS } from "@worthline/pricing";
import { runNumistaCoinRefresh } from "./numista-coin-refresh";

const NOW = "2026-06-15T12:00:00.000Z";
const TWO_DAYS_AGO = "2026-06-13T12:00:00.000Z";

/** A store holding one connected Numista source whose valuation has lapsed. */
function storeStub(revaluePositions = vi.fn(async () => {})) {
  return {
    connectedSources: {
      listSources: vi.fn(async () => [
        { adapter: "numista", assetId: "asset-1", id: "src-1" },
      ]),
      readPositions: vi.fn(async () => []),
      readSource: vi.fn(async () => ({
        credentialsJson: JSON.stringify({ apiKey: "key" }),
        id: "src-1",
        tokenJson: JSON.stringify({ accessToken: "t", expiresAt: 9e15 }),
      })),
      revaluePositions,
      saveToken: vi.fn(async () => {}),
    },
    operations: {
      readPriceCache: vi.fn(async () => ({
        assetId: "asset-1",
        currency: "EUR",
        fetchedAt: TWO_DAYS_AGO, // past the daily TTL → the source is due
        freshnessState: "fresh",
        price: "10000",
        source: "numista",
      })),
    },
  };
}

describe("runNumistaCoinRefresh", () => {
  beforeEach(() => {
    refreshCoinValuations.mockClear();
  });

  it("hands the pass a checkpoint of REVALUE_CHECKPOINT_COINS that banks without stamping", async () => {
    const revaluePositions = vi.fn(async () => {});
    const store = storeStub(revaluePositions);

    // biome-ignore lint/suspicious/noExplicitAny: a stub store, not a real one
    await runNumistaCoinRefresh(store as any, NOW);

    expect(refreshCoinValuations).toHaveBeenCalledTimes(1);
    const options = refreshCoinValuations.mock.calls[0]?.[2];
    expect(options?.checkpoint?.every).toBe(REVALUE_CHECKPOINT_COINS);

    // Banking a tranche writes the coins with a NULL freshness: the row's stamp is
    // what the staleness gate reads, so an unfinished pass must not touch it.
    const banked = [{ id: "pos-1" }];
    await options?.checkpoint?.persist(banked);

    expect(revaluePositions).toHaveBeenCalledWith("src-1", banked, null);
  });
});
