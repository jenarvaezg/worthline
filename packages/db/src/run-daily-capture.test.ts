import { captureDailySnapshotForWorkspace } from "@db/capture-daily-snapshot";
import { createInMemoryStore } from "@db/index";
import {
  type DailyCaptureFetchedPrice,
  type DailyCapturePricePair,
  runDailyCapture,
} from "@db/run-daily-capture";
import type { WorthlineStore } from "@db/store-types";
import { describe, expect, test, vi } from "vitest";

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
  await store.command.recordInvestmentOperation(
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

  test("a partial-failure run is not finalized, so a same-day retry is not skipped", async () => {
    const good = await seededStore();
    const finalized = new Set<string>();
    const listAllWorkspaces = vi.fn(async () => [
      { id: "bad", dbUrl: "libsql://bad" },
      { id: "good", dbUrl: "libsql://good" },
    ]);
    const markRunFinalized = vi.fn(async (dateKey: string) => {
      finalized.add(dateKey);
    });

    const deps = {
      listAllWorkspaces,
      openStore: async (ws: { id: string }) => {
        if (ws.id === "bad") throw new Error("unreachable workspace DB");
        return keepOpen(good);
      },
      fetchPrices: noFetchedPrices,
      isRunFinalized: async (dateKey: string) => finalized.has(dateKey),
      markRunFinalized,
      now: NOW,
    };

    const first = await runDailyCapture(deps);
    const second = await runDailyCapture(deps);

    expect(first.failures).toHaveLength(1);
    expect(second.skipped).toBeUndefined();
    expect(second.failures).toHaveLength(1);
    expect(listAllWorkspaces).toHaveBeenCalledTimes(2);
    expect(markRunFinalized).not.toHaveBeenCalled();
    expect(finalized.has(TODAY)).toBe(false);

    good.close();
  });

  test("first finalized run of a day overrides a provisional render snapshot", async () => {
    const store = await seededStore();
    const finalized = new Set<string>();

    await captureDailySnapshotForWorkspace(store, "2026-06-25T08:00:00.000Z");
    expect((await store.snapshots.readSnapshots("household"))[0]!.capturedAt).toBe(
      "2026-06-25T08:00:00.000Z",
    );

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: noFetchedPrices,
      isRunFinalized: async (dateKey) => finalized.has(dateKey),
      markRunFinalized: async (dateKey) => {
        finalized.add(dateKey);
      },
      now: NOW,
    });

    const close = await store.snapshots.readSnapshots("household");
    expect(result).toMatchObject({ total: 1, captured: 1, failures: [] });
    expect(close).toHaveLength(1);
    expect(close[0]!.dateKey).toBe(TODAY);
    expect(close[0]!.capturedAt).toBe(NOW);
    // The finalization guard is keyed by the pass-qualified run key (#895): NOW
    // is 21:00 UTC → the evening (`pm`) pass. `result.dateKey` stays the bare date.
    expect(finalized.has(`${TODAY}:pm`)).toBe(true);
    expect(result.dateKey).toBe(TODAY);

    store.close();
  });

  test("same-day retrigger short-circuits at run level before fetching prices", async () => {
    const store = await seededMarketStore("fund", "AAPL", "1");
    const finalized = new Set<string>();
    const listAllWorkspaces = vi.fn(async () => [{ id: "ws", dbUrl: "libsql://ws" }]);
    const fetchPrices = vi.fn(
      async (): Promise<DailyCaptureFetchedPrice[]> => [
        {
          provider: "yahoo",
          symbol: "AAPL",
          currency: "EUR",
          fetchedAt: NOW,
          freshnessState: "fresh",
          price: "250",
          source: "yahoo",
        },
      ],
    );
    const deps = {
      listAllWorkspaces,
      openStore: async () => keepOpen(store),
      fetchPrices,
      isRunFinalized: async (dateKey: string) => finalized.has(dateKey),
      markRunFinalized: async (dateKey: string) => {
        finalized.add(dateKey);
      },
      now: NOW,
    };

    await runDailyCapture(deps);
    const second = await runDailyCapture(deps);

    expect(second).toMatchObject({
      total: 0,
      captured: 0,
      failures: [],
      skipped: true,
    });
    expect(listAllWorkspaces).toHaveBeenCalledOnce();
    expect(fetchPrices).toHaveBeenCalledOnce();

    store.close();
  });

  test("benchmark source failures do not block snapshot capture", async () => {
    const store = await seededStore();

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: noFetchedPrices,
      listBenchmarkSeries: async () => [{ id: "ipc-es" }],
      readBenchmarkPrices: async () => [],
      fetchBenchmarkPrices: async () => {
        throw new Error("INE outage");
      },
      saveBenchmarkPrices: async () => {
        throw new Error("should not save");
      },
      now: NOW,
    });

    expect(result).toMatchObject({
      total: 1,
      captured: 1,
      failures: [],
      benchmarkFailures: [{ seriesId: "ipc-es", error: "INE outage" }],
    });
    expect(await store.snapshots.readSnapshots("household")).toHaveLength(1);

    store.close();
  });

  test("benchmark phase stores only months missing from the control-plane cache", async () => {
    const saveBenchmarkPrices = vi.fn(async () => {});

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [],
      openStore: async () => {
        throw new Error("no workspaces to open");
      },
      fetchPrices: noFetchedPrices,
      listBenchmarkSeries: async () => [{ id: "ipc-es" }],
      readBenchmarkPrices: async () => [
        { seriesId: "ipc-es", dateKey: "2024-01-01", value: "100" },
      ],
      fetchBenchmarkPrices: async () => [
        { dateKey: "2024-01-01", value: "100" },
        { dateKey: "2024-02-01", value: "101.2" },
      ],
      saveBenchmarkPrices,
      now: NOW,
    });

    expect(result.benchmarkFailures).toEqual([]);
    expect(saveBenchmarkPrices).toHaveBeenCalledWith("ipc-es", [
      { dateKey: "2024-02-01", value: "101.2" },
    ]);
  });
});

describe("runDailyCapture — connected-source sync phase (#895)", () => {
  test("collects syncConnectedSources errors into sourceSyncFailures without blocking capture or finalization", async () => {
    const a = await seededStore();
    const b = await seededStore();
    const finalized = new Set<string>();
    const syncConnectedSources = vi.fn(async () => ({
      errors: ["Binance: revisa la conexión."],
    }));

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [
        { id: "wsA", dbUrl: "libsql://a" },
        { id: "wsB", dbUrl: "libsql://b" },
      ],
      openStore: async (ws) => keepOpen(ws.id === "wsA" ? a : b),
      fetchPrices: noFetchedPrices,
      syncConnectedSources,
      isRunFinalized: async (runKey) => finalized.has(runKey),
      markRunFinalized: async (runKey) => {
        finalized.add(runKey);
      },
      now: NOW,
    });

    // Sync degradations are surfaced per workspace but never counted as failures…
    expect(result.failures).toEqual([]);
    expect(result.captured).toBe(2);
    expect(result.sourceSyncFailures).toEqual([
      { workspaceId: "wsA", error: "Binance: revisa la conexión." },
      { workspaceId: "wsB", error: "Binance: revisa la conexión." },
    ]);
    // …so they do NOT block run finalization (the pass still marks finalized).
    expect(finalized.has(`${TODAY}:pm`)).toBe(true);

    a.close();
    b.close();
  });

  test("isolates a syncConnectedSources that throws — the snapshot is still captured", async () => {
    const store = await seededStore();
    const syncConnectedSources = vi.fn(async () => {
      throw new Error("sync crashed");
    });

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: noFetchedPrices,
      syncConnectedSources,
      now: NOW,
    });

    // The crash is recorded as a source-sync degradation, not a capture failure…
    expect(result.captured).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.sourceSyncFailures).toEqual([
      { workspaceId: "ws", error: "sync crashed" },
    ]);
    // …and the snapshot was still captured despite the sync crash.
    expect(await store.snapshots.readSnapshots("household")).toHaveLength(1);

    store.close();
  });

  test("invokes syncConnectedSources once per workspace, before capturing its snapshot", async () => {
    const a = await seededStore();
    const b = await seededStore();
    const syncConnectedSources = vi.fn(async (store: WorthlineStore) => {
      // Sync runs BEFORE capture, so today's snapshot must not exist yet. A thrown
      // assertion here surfaces as a sourceSyncFailure — asserted empty below, so
      // an out-of-order call fails the test rather than being silently swallowed.
      expect(await store.snapshots.readSnapshots("household")).toHaveLength(0);
      return { errors: [] };
    });

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [
        { id: "wsA", dbUrl: "libsql://a" },
        { id: "wsB", dbUrl: "libsql://b" },
      ],
      openStore: async (ws) => keepOpen(ws.id === "wsA" ? a : b),
      fetchPrices: noFetchedPrices,
      syncConnectedSources,
      now: NOW,
    });

    expect(syncConnectedSources).toHaveBeenCalledTimes(2);
    expect(syncConnectedSources).toHaveBeenCalledWith(expect.anything(), NOW);
    expect(result.sourceSyncFailures).toEqual([]);
    expect(result.captured).toBe(2);

    a.close();
    b.close();
  });

  test("pauses connected-source sync for a workspace the gate denies, still capturing its snapshot (#1162)", async () => {
    const free = await seededStore();
    const premium = await seededStore();
    const syncConnectedSources = vi.fn(async () => ({ errors: [] }));

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [
        { id: "wsFree", dbUrl: "libsql://free" },
        { id: "wsPremium", dbUrl: "libsql://premium" },
      ],
      openStore: async (ws) => keepOpen(ws.id === "wsFree" ? free : premium),
      fetchPrices: noFetchedPrices,
      syncConnectedSources,
      // Free workspace's sources are paused; premium's still sync.
      shouldSyncConnectedSources: async (ws) => ws.id !== "wsFree",
      now: NOW,
    });

    // The paused workspace never syncs, the premium one does — exactly once.
    expect(syncConnectedSources).toHaveBeenCalledTimes(1);
    // Both snapshots are still captured: the pause never blocks valuation.
    expect(result.captured).toBe(2);
    expect(result.sourceSyncFailures).toEqual([]);
    expect(await free.snapshots.readSnapshots("household")).toHaveLength(1);
    expect(await premium.snapshots.readSnapshots("household")).toHaveLength(1);

    free.close();
    premium.close();
  });

  test("a gate read that throws never blocks the free snapshot — pause is fail-closed, capture still runs (#1162)", async () => {
    const store = await seededStore();
    const finalized = new Set<string>();
    const syncConnectedSources = vi.fn(async () => ({ errors: [] }));

    const result = await runDailyCapture({
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: noFetchedPrices,
      syncConnectedSources,
      shouldSyncConnectedSources: async () => {
        throw new Error("control plane unreachable");
      },
      isRunFinalized: async (runKey) => finalized.has(runKey),
      markRunFinalized: async (runKey) => {
        finalized.add(runKey);
      },
      now: NOW,
    });

    // The gate failure paused the sync (never called) but is only a degradation…
    expect(syncConnectedSources).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    expect(result.sourceSyncFailures).toEqual([
      { workspaceId: "ws", error: "control plane unreachable" },
    ]);
    // …so the free snapshot was still captured and the pass still finalized.
    expect(result.captured).toBe(1);
    expect(await store.snapshots.readSnapshots("household")).toHaveLength(1);
    expect(finalized.has(`${TODAY}:pm`)).toBe(true);

    store.close();
  });

  test("morning and evening passes finalize independently — the evening close overwrites the morning point", async () => {
    const store = await seededStore();
    const finalized = new Set<string>();
    const AM = "2026-06-25T09:00:00.000Z";
    const deps = (now: string) => ({
      listAllWorkspaces: async () => [{ id: "ws", dbUrl: "libsql://ws" }],
      openStore: async () => keepOpen(store),
      fetchPrices: noFetchedPrices,
      isRunFinalized: async (runKey: string) => finalized.has(runKey),
      markRunFinalized: async (runKey: string) => {
        finalized.add(runKey);
      },
      now,
    });

    const morning = await runDailyCapture(deps(AM));
    const evening = await runDailyCapture(deps(NOW));

    // Both passes ran — the pm pass is NOT skipped by the am pass's finalization…
    expect(morning.skipped).toBeUndefined();
    expect(evening.skipped).toBeUndefined();
    expect(morning.captured).toBe(1);
    expect(evening.captured).toBe(1);
    expect(finalized.has(`${TODAY}:am`)).toBe(true);
    expect(finalized.has(`${TODAY}:pm`)).toBe(true);

    // …and latest-wins (ADR 0005): one today snapshot, stamped at the pm NOW.
    const snapshots = await store.snapshots.readSnapshots("household");
    expect(snapshots.filter((s) => s.dateKey === TODAY)).toHaveLength(1);
    expect(snapshots.find((s) => s.dateKey === TODAY)!.capturedAt).toBe(NOW);

    store.close();
  });
});

describe("captureDailySnapshotForWorkspace — every scope (#895)", () => {
  test("captures a snapshot and rows for EVERY scope, not just the first", async () => {
    // The GET no longer captures (cache-only, #895), so the multi-scope capture
    // guarantee lives solely on this path now. member_jose owns the asset
    // outright, so both the household scope and his member scope capture it — a
    // future refactor of the scope loop that only wrote scopes[0] must fail here.
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Caja",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });

    await captureDailySnapshotForWorkspace(store, NOW);

    for (const scopeId of ["household", "mJ"]) {
      const snapshots = await store.snapshots.readSnapshots(scopeId);
      expect(snapshots.filter((s) => s.dateKey === TODAY)).toHaveLength(1);
      const rows = await store.snapshots.readSnapshotHoldings({ scopeId });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.holdingId).toBe("asset_cash");
    }

    store.close();
  });
});
