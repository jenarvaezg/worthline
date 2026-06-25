import { describe, expect, test, vi } from "vitest";

import { createInMemoryStore } from "@db/index";
import {
  runDailyCapture,
  type DailyCaptureFetchedPrice,
  type DailyCapturePricePair,
} from "@db/run-daily-capture";
import type { WorthlineStore } from "@db/store-types";

const NOW = "2026-06-25T21:00:00.000Z";
const TODAY = "2026-06-25";

/** A seeded, single-member workspace — capture writes a (zero-value) snapshot. */
async function seededStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

async function seededMarketStore(
  assetId: string,
  symbol: string,
  units: string,
): Promise<WorthlineStore> {
  const store = await seededStore();
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: assetId,
    liquidityTier: "market",
    name: assetId,
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "yahoo",
    providerSymbol: symbol,
  });
  await store.recordOperationAndRipple(
    {
      assetId,
      currency: "EUR",
      executedAt: "2026-01-01",
      feesMinor: 0,
      id: `op_${assetId}`,
      kind: "buy",
      pricePerUnit: "100",
      units,
    },
    { today: TODAY },
  );
  return store;
}

/**
 * `runDailyCapture` closes every store it opens; wrap so the test can still read
 * the persisted snapshots afterwards. The real store is closed at test end.
 */
function keepOpen(store: WorthlineStore): WorthlineStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "close") return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function noFetchedPrices(): Promise<DailyCaptureFetchedPrice[]> {
  return [];
}

describe("runDailyCapture (ADR 0037, PRD #528)", () => {
  test("deduplicates price fetches by provider symbol and warms every workspace cache before capture", async () => {
    const a = await seededMarketStore("fund_a", "AAPL", "10");
    const b = await seededMarketStore("fund_b", "AAPL", "2");
    const fetchPrices = vi.fn(
      async (pairs: DailyCapturePricePair[]): Promise<DailyCaptureFetchedPrice[]> => {
        expect(pairs).toEqual([{ provider: "yahoo", symbol: "AAPL", currency: "EUR" }]);
        return [
          {
            provider: "yahoo",
            symbol: "AAPL",
            currency: "EUR",
            price: "250",
            source: "yahoo",
            fetchedAt: NOW,
            freshnessState: "fresh",
          },
        ];
      },
    );

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [
        { id: "wsA", dbUrl: "libsql://a" },
        { id: "wsB", dbUrl: "libsql://b" },
      ],
      openStore: async (ws) => keepOpen(ws.id === "wsA" ? a : b),
      fetchPrices,
      now: NOW,
    });

    expect(result).toMatchObject({ total: 2, captured: 2, failures: [] });
    expect(fetchPrices).toHaveBeenCalledOnce();

    expect(await a.operations.readPriceCache("fund_a")).toMatchObject({
      price: "250",
      freshnessState: "fresh",
    });
    expect(await b.operations.readPriceCache("fund_b")).toMatchObject({
      price: "250",
      freshnessState: "fresh",
    });

    expect(
      (await a.snapshots.readSnapshots("household")).find(
        (snap) => snap.dateKey === TODAY,
      )?.grossAssets.amountMinor,
    ).toBe(2_500_00);
    expect(
      (await b.snapshots.readSnapshots("household")).find(
        (snap) => snap.dateKey === TODAY,
      )?.grossAssets.amountMinor,
    ).toBe(500_00);

    a.close();
    b.close();
  });

  test("failed fleet fetches do not overwrite warm cache rows or snapshot zero prices", async () => {
    const store = await seededMarketStore("fund", "AAPL", "10");
    await store.operations.upsertPrice({
      assetId: "fund",
      currency: "EUR",
      fetchedAt: "2026-06-24T21:00:00.000Z",
      freshnessState: "fresh",
      price: "100",
      source: "yahoo",
    });

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: async (): Promise<DailyCaptureFetchedPrice[]> => [
        {
          provider: "yahoo",
          symbol: "AAPL",
          currency: "EUR",
          fetchedAt: NOW,
          freshnessState: "failed",
          price: "0",
          source: "yahoo",
          staleReason: "provider outage",
        },
      ],
      now: NOW,
    });

    expect(result).toMatchObject({ total: 1, captured: 1, failures: [] });
    expect(await store.operations.readPriceCache("fund")).toMatchObject({
      fetchedAt: "2026-06-24T21:00:00.000Z",
      freshnessState: "fresh",
      price: "100",
    });
    expect(
      (await store.snapshots.readSnapshots("household")).find(
        (snap) => snap.dateKey === TODAY,
      )?.grossAssets.amountMinor,
    ).toBe(1_000_00);

    store.close();
  });

  test("a workspace that fails to open does not block the others (isolation)", async () => {
    const good = await seededStore();

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [
        { id: "bad", dbUrl: "libsql://bad" },
        { id: "good", dbUrl: "libsql://good" },
      ],
      openStore: async (ws) => {
        if (ws.id === "bad") throw new Error("unreachable workspace DB");
        return keepOpen(good);
      },
      fetchPrices: noFetchedPrices,
      now: NOW,
    });

    expect(result.captured).toBe(1);
    expect(result.failures).toEqual([
      { workspaceId: "bad", error: expect.stringContaining("unreachable") },
    ]);
    expect(await good.snapshots.readSnapshots("household")).toHaveLength(1);
    good.close();
  });

  test("capture is unconditional: a same-day point is overridden, never duplicated", async () => {
    const store = await seededStore();
    const deps = {
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: noFetchedPrices,
    };

    // A morning render-style provisional point.
    await runDailyCapture({ ...deps, now: "2026-06-25T08:00:00.000Z" });
    const morning = await store.snapshots.readSnapshots("household");
    expect(morning).toHaveLength(1);
    expect(morning[0]!.capturedAt).toBe("2026-06-25T08:00:00.000Z");

    // The close-of-day run overrides it (latest-wins), no duplicate.
    await runDailyCapture({ ...deps, now: NOW });
    const close = await store.snapshots.readSnapshots("household");
    expect(close).toHaveLength(1);
    expect(close[0]!.dateKey).toBe(TODAY);
    expect(close[0]!.capturedAt).toBe(NOW);

    store.close();
  });
});
