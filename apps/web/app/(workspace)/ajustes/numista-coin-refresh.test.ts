/**
 * Production wiring of the coin-valuation refresh (PRD #166, ADR 0017).
 *
 * The orchestration and the valuation are unit-tested on their own; what only this
 * seam can show is that the two are actually BOUND — that the pass gets a
 * checkpoint (#1739), the mechanism that keeps a killed pass from re-buying the
 * collection, and that a Numista failure reaches the pass with its class intact
 * (#1761): this wiring is where "no estimate for this issue" and "Numista has
 * stopped answering" were once both collapsed into `null`, so a dead provider was
 * asked about every coin in the collection, every night. The Numista/Yahoo network
 * and the store are stubbed.
 */
import type { ValuationFreshness } from "@worthline/db";
import type { CoinPosition } from "@worthline/domain";
import type { RevaluedPosition } from "@worthline/pricing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@worthline/pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@worthline/pricing")>();
  return {
    ...actual,
    // The free reads, stubbed away so the only network left is the CAPPED one.
    fetchMetalSpotEur: vi.fn(async () => 28),
    isTokenValid: vi.fn(() => true),
    mintNumistaToken: vi.fn(async () => ({ accessToken: "t", expiresAt: 0 })),
    // The REAL pass behind a spy: the checkpoint test reads what the wiring hands
    // it, and the cut tests need it to actually run against the estimate reads.
    refreshCoinValuations: vi.fn(actual.refreshCoinValuations),
  };
});

import { REVALUE_CHECKPOINT_COINS, refreshCoinValuations } from "@worthline/pricing";
import { runNumistaCoinRefresh } from "./numista-coin-refresh";

const NOW = "2026-06-15T12:00:00.000Z";
const TWO_DAYS_AGO = "2026-06-13T12:00:00.000Z";
/** 45 days before NOW → past the 30-day numismatic TTL: the coin is due a read. */
const ESTIMATE_LAPSED = "2026-05-01T12:00:00.000Z";

const ESTIMATE = { currency: "EUR", prices: [{ grade: "unc", price: 75.585 }] };

/** A stored silver eagle whose estimate has lapsed, on an issue of its own. */
function dueCoin(n: number): CoinPosition {
  return {
    kind: "coin",
    catalogueId: "1493",
    currency: "EUR",
    externalId: `ext-${n}`,
    finenessMillis: 999,
    grade: "unc",
    id: `pos-${n}`,
    issueId: 32720 + n,
    liquidityTier: "illiquid",
    metal: "silver",
    metalValueMinor: 2797, // already what 31.103 g × .999 × 28 €/oz comes to
    name: "Silver Eagle",
    numismaticFetchedAt: ESTIMATE_LAPSED,
    numismaticValueMinor: 1,
    obverseThumbUrl: null,
    purchaseDate: null,
    purchasePriceMinor: null,
    quantity: 1,
    sourceId: "src-1",
    weightGrams: 31.103,
    year: 2021,
  };
}

type RevaluePositions = (
  sourceId: string,
  updates: RevaluedPosition[],
  freshness: ValuationFreshness | null,
) => Promise<void>;

/** A store holding one connected Numista source whose valuation has lapsed. */
function storeStub(
  revaluePositions = vi.fn<RevaluePositions>(async () => {}),
  positions: CoinPosition[] = [],
) {
  return {
    connectedSources: {
      listSources: vi.fn(async () => [
        { adapter: "numista", assetId: "asset-1", id: "src-1" },
      ]),
      readPositions: vi.fn(async () => positions),
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

/**
 * Numista over the wire: it answers every issue but `failOn`, where it returns
 * `status`. Stubbing `fetch` rather than the reader keeps the whole chain real —
 * HTTP status → typed error → provider-vs-item classification → the pass's
 * decision — and makes the call count the actual requests spent of the monthly
 * cap, which is what #1761 is measured in.
 */
function numistaAnsweringExcept(failOn: number, status: number) {
  return vi.fn(async (url: string | URL) => {
    const issueId = Number(String(url).match(/issues\/(\d+)/)?.[1]);
    if (issueId === failOn) {
      return { ok: false, status } as Response;
    }
    return { ok: true, json: async () => ESTIMATE } as Response;
  });
}

describe("runNumistaCoinRefresh", () => {
  beforeEach(() => {
    vi.mocked(refreshCoinValuations).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the pass a checkpoint of REVALUE_CHECKPOINT_COINS that banks without stamping", async () => {
    const revaluePositions = vi.fn<RevaluePositions>(async () => {});
    const store = storeStub(revaluePositions);

    // biome-ignore lint/suspicious/noExplicitAny: a stub store, not a real one
    await runNumistaCoinRefresh(store as any, NOW);

    expect(refreshCoinValuations).toHaveBeenCalledTimes(1);
    const options = vi.mocked(refreshCoinValuations).mock.calls[0]?.[2];
    expect(options?.checkpoint?.every).toBe(REVALUE_CHECKPOINT_COINS);

    // Banking a tranche writes the coins with a NULL freshness: the row's stamp is
    // what the staleness gate reads, so an unfinished pass must not touch it.
    const banked = [
      {
        id: "pos-1",
        metalValueMinor: 1,
        numismaticValueMinor: 1,
        numismaticFetchedAt: NOW,
      },
    ];
    await options?.checkpoint?.persist(banked);

    expect(revaluePositions).toHaveBeenCalledWith("src-1", banked, null);
  });

  // #1761, the regression: N coins due, Numista answers 429 on the third → the pass
  // stops there. It used to ask about all N — each answer `null`, no stamp moving,
  // the pass ending `fresh` — and do it again the next night.
  it("stops paying once Numista answers 429: three reads over five due coins, not five", async () => {
    const revaluePositions = vi.fn<RevaluePositions>(async () => {});
    const store = storeStub(revaluePositions, [1, 2, 3, 4, 5].map(dueCoin));
    const numista = numistaAnsweringExcept(32723, 429);
    vi.stubGlobal("fetch", numista);

    // biome-ignore lint/suspicious/noExplicitAny: a stub store, not a real one
    const result = await runNumistaCoinRefresh(store as any, NOW);

    // The quota answer on coin 3 ends the pass: coins 4 and 5 are never asked for.
    // Exactly three requests — the 429 is not retried either (a monthly quota does
    // not clear inside a backoff), so it costs one request, not three.
    expect(numista).toHaveBeenCalledTimes(3);

    // The two coins bought before it are kept, and the source is left stale with
    // the reason — carrying the prior stamp so the next pass retries (#1739).
    expect(revaluePositions).toHaveBeenCalledTimes(1);
    const [, updates, freshness] = revaluePositions.mock.calls[0]!;
    expect(updates.map((update) => update.id)).toEqual(["pos-1", "pos-2"]);
    expect(freshness).toMatchObject({
      fetchedAt: TWO_DAYS_AGO,
      freshnessState: "stale",
      staleReason: expect.stringMatching(/cupo/i),
    });
    expect(result.errors).toHaveLength(1);
  });

  it("keeps going past an issue Numista has no estimate for (404): every coin is read, the source ends fresh", async () => {
    const revaluePositions = vi.fn<RevaluePositions>(async () => {});
    const store = storeStub(revaluePositions, [1, 2, 3, 4, 5].map(dueCoin));
    const numista = numistaAnsweringExcept(32723, 404);
    vi.stubGlobal("fetch", numista);

    // biome-ignore lint/suspicious/noExplicitAny: a stub store, not a real one
    const result = await runNumistaCoinRefresh(store as any, NOW);

    // A verdict on ONE issue is not a verdict on the provider: the pass moves on.
    expect(numista).toHaveBeenCalledTimes(5);

    // Coin 3 keeps its prior figure and stamp (#1740) — nothing to write for it.
    const [, updates, freshness] = revaluePositions.mock.calls[0]!;
    expect(updates.map((update) => update.id)).toEqual([
      "pos-1",
      "pos-2",
      "pos-4",
      "pos-5",
    ]);
    expect(freshness).toEqual({ fetchedAt: NOW, freshnessState: "fresh" });
    expect(result.errors).toEqual([]);
  });
});
