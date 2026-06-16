/**
 * Integration tests for the Binance connected-source actions via the `_store`
 * injection seam (PRD #245, ADR 0021). connectBinanceAction reads the scope cookie
 * from next/headers, which has no request context here, so it is exercised by its
 * pure helpers (binance-helpers.test.ts) and the store API directly; these tests
 * cover the cookie-free actions: sync's guard + happy path (stubbing global
 * `fetch` for the signed balances + CoinGecko price), and disconnect's cascade.
 */

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import { disconnectBinanceAction, syncBinanceAction } from "./binance-actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Run an action and return the NEXT_REDIRECT digest (the redirect target). */
async function runAction(
  action: (fd: FormData, store: WorthlineStore) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
): Promise<string> {
  try {
    await action(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

function seedWithSource(store: WorthlineStore): { sourceId: string; assetId: string } {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  return store.connectedSources.connect({
    adapter: "binance",
    label: "Binance",
    credentialsJson: JSON.stringify({ apiKey: "key", apiSecret: "secret" }),
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("disconnectBinanceAction", () => {
  test("removes the source, its positions, and the projected holding (cascade)", async () => {
    const store = createInMemoryStore();
    const { sourceId, assetId } = seedWithSource(store);

    // Give it a position so we can prove the cascade also clears positions.
    store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "token",
          externalId: "BTC:spot",
          name: "BTC",
          symbol: "BTC",
          balance: "0.5",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "50000",
          currency: "EUR",
        },
      ],
      "2026-06-16T10:00:00.000Z",
    );

    expect(store.connectedSources.listSources()).toHaveLength(1);
    expect(store.assets.readAssets().some((a) => a.id === assetId)).toBe(true);

    const digest = await runAction(
      disconnectBinanceAction,
      form({ currentUrl: "/ajustes", sourceId }),
      store,
    );

    expect(digest).toContain("ok=binance_disconnected");
    expect(store.connectedSources.listSources()).toHaveLength(0);
    expect(store.connectedSources.readSource(sourceId)).toBeNull();
    expect(store.assets.readAssets().some((a) => a.id === assetId)).toBe(false);
  });

  test("removes BOTH the market and term-locked assets of a multi-rung source (#248)", async () => {
    const store = createInMemoryStore();
    const { sourceId } = seedWithSource(store);

    // Spot (market) + locked-earn (term-locked) → two materialized assets.
    store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "token",
          externalId: "BTC:spot",
          name: "BTC",
          symbol: "BTC",
          balance: "0.5",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "50000",
          currency: "EUR",
        },
        {
          kind: "token",
          externalId: "ETH:locked-earn",
          name: "ETH",
          symbol: "ETH",
          balance: "3",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
          unitPrice: "2000",
          currency: "EUR",
        },
      ],
      "2026-06-16T10:00:00.000Z",
    );

    expect(store.connectedSources.listSourceAssetIds(sourceId)).toHaveLength(2);

    const digest = await runAction(
      disconnectBinanceAction,
      form({ currentUrl: "/ajustes", sourceId }),
      store,
    );

    expect(digest).toContain("ok=binance_disconnected");
    expect(store.connectedSources.listSources()).toHaveLength(0);
    // No crypto asset survives — both rungs were removed, positions cascaded.
    expect(store.assets.readAssets().some((a) => a.instrument === "crypto")).toBe(false);
  });

  test("errors when no source id is supplied", async () => {
    const store = createInMemoryStore();
    seedWithSource(store);

    const digest = await runAction(
      disconnectBinanceAction,
      form({ currentUrl: "/ajustes" }),
      store,
    );

    expect(digest).toContain("error=");
    expect(store.connectedSources.listSources()).toHaveLength(1);
  });

  test("mode=freeze keeps EVERY rung as a hand-valued holding instead of removing it", async () => {
    const store = createInMemoryStore();
    const { sourceId, assetId } = seedWithSource(store);

    // Market spot + term-locked locked-earn → two materialized crypto assets.
    store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "token",
          externalId: "BTC:spot",
          name: "BTC",
          symbol: "BTC",
          balance: "0.5",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "50000",
          currency: "EUR",
        },
        {
          kind: "token",
          externalId: "ETH:locked-earn",
          name: "ETH",
          symbol: "ETH",
          balance: "3",
          wallet: "locked-earn",
          liquidityTier: "term-locked",
          unitPrice: "2000",
          currency: "EUR",
        },
      ],
      "2026-06-16T10:00:00.000Z",
    );
    const termLockedId = store.connectedSources
      .listSourceAssetIds(sourceId)
      .find((id) => id !== assetId)!;

    const digest = await runAction(
      disconnectBinanceAction,
      form({ currentUrl: "/ajustes", sourceId, mode: "freeze" }),
      store,
    );

    expect(digest).toContain("ok=binance_frozen");
    // The source is gone but BOTH rung holdings survive as plain hand-valued
    // `other` assets (no longer crypto, no longer connected).
    expect(store.connectedSources.listSources()).toHaveLength(0);
    const surviving = store.assets
      .readAssets()
      .filter((a) => a.id === assetId || a.id === termLockedId);
    expect(surviving).toHaveLength(2);
    expect(surviving.every((a) => a.instrument === "other")).toBe(true);
    expect(store.assets.readAssets().some((a) => a.instrument === "crypto")).toBe(false);

    // The freeze DETACHES both rung assets end-to-end — neither routes back to the
    // (now deleted) source any more.
    expect(store.connectedSources.readSourceIdForAsset(assetId)).toBeNull();
    expect(store.connectedSources.readSourceIdForAsset(termLockedId)).toBeNull();
  });
});

describe("syncBinanceAction", () => {
  test("errors (without wiping positions) when the source id is unknown", async () => {
    const store = createInMemoryStore();
    const { sourceId } = seedWithSource(store);
    store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "token",
          externalId: "ETH:spot",
          name: "ETH",
          symbol: "ETH",
          balance: "2",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "2000",
          currency: "EUR",
        },
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const digest = await runAction(
      syncBinanceAction,
      form({ currentUrl: "/ajustes", sourceId: "missing" }),
      store,
    );

    expect(digest).toContain("error=");
    // The real source's positions are untouched.
    expect(store.connectedSources.readPositions(sourceId)).toHaveLength(1);
  });

  test("pulls spot+funding+flexible-Earn balances + live prices and merges positions (stubbed fetch)", async () => {
    const store = createInMemoryStore();
    const { sourceId, assetId } = seedWithSource(store);

    // Stub global fetch: the three signed Binance wallet endpoints, then CoinGecko.
    // BTC sits on spot AND funding; ETH on flexible Earn (#247 fold-in).
    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/v3/account")) {
        return {
          ok: true,
          json: async () => ({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] }),
        } as unknown as Response;
      }
      if (url.includes("/sapi/v1/asset/get-funding-asset")) {
        return {
          ok: true,
          json: async () => [{ asset: "BTC", free: "0.1", locked: "0", freeze: "0" }],
        } as unknown as Response;
      }
      if (url.includes("/sapi/v1/simple-earn/flexible/position")) {
        return {
          ok: true,
          json: async () => ({ rows: [{ asset: "ETH", totalAmount: "2" }], total: 1 }),
        } as unknown as Response;
      }
      if (url.includes("/sapi/v1/simple-earn/locked/position")) {
        return {
          ok: true,
          json: async () => ({ rows: [], total: 0 }),
        } as unknown as Response;
      }
      if (url.includes("api.coingecko.com")) {
        return {
          ok: true,
          json: async () => ({ bitcoin: { eur: 50_000 }, ethereum: { eur: 2_000 } }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const digest = await runAction(
      syncBinanceAction,
      form({ currentUrl: "/ajustes", sourceId }),
      store,
    );

    expect(digest).toContain("ok=binance_synced");

    // One position per (asset, wallet) — BTC split spot/funding, ETH on Earn.
    const positions = store.connectedSources.readPositions(sourceId);
    expect(positions).toHaveLength(3);
    expect(
      positions.map((p) => (p.kind === "token" ? `${p.symbol}:${p.wallet}` : "")).sort(),
    ).toEqual(["BTC:funding", "BTC:spot", "ETH:flexible-earn"]);

    // A manual sync stamps the `binance` freshness row fresh (PRD #245 S4) so the
    // daily stale-price pass won't immediately re-sync the source it just synced.
    const freshness = store.operations.readPriceCache(assetId);
    expect(freshness?.freshnessState).toBe("fresh");
  });

  test("step 4 backfills the reconstructed monthly history into snapshots (accountSnapshot + range stubbed)", async () => {
    const store = createInMemoryStore();
    const { sourceId, assetId } = seedWithSource(store);

    // The action reads the wall clock (`new Date()`) — it takes NO injected clock —
    // so the backfill anchor must be a month deterministically COMPLETED relative to
    // any real run. 2020-01 is decades in the past, so its month-end 2020-01-31 is
    // always strictly before the current month and reliably materializes.
    const SNAPSHOT_MS = Date.UTC(2020, 0, 31); // 2020-01-31 → completed month-end

    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = String(input);
      // Live positions sync (step 3): a single spot BTC balance.
      if (url.includes("/api/v3/account")) {
        return {
          ok: true,
          json: async () => ({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] }),
        } as unknown as Response;
      }
      if (url.includes("/sapi/v1/asset/get-funding-asset")) {
        return { ok: true, json: async () => [] } as unknown as Response;
      }
      if (url.includes("/sapi/v1/simple-earn/flexible/position")) {
        return {
          ok: true,
          json: async () => ({ rows: [], total: 0 }),
        } as unknown as Response;
      }
      if (url.includes("/sapi/v1/simple-earn/locked/position")) {
        return {
          ok: true,
          json: async () => ({ rows: [], total: 0 }),
        } as unknown as Response;
      }
      // Step 4 reconstruction: the signed daily SPOT snapshot horizon — one
      // completed month-end with 0.5 BTC.
      if (url.includes("/sapi/v1/accountSnapshot")) {
        return {
          ok: true,
          json: async () => ({
            snapshotVos: [
              {
                updateTime: SNAPSHOT_MS,
                data: { balances: [{ asset: "BTC", free: "0.5", locked: "0" }] },
              },
            ],
          }),
        } as unknown as Response;
      }
      // Step 4 price series — MUST be matched before the generic coingecko live
      // price below, since both share the `api.coingecko.com` host.
      if (url.includes("/market_chart/range")) {
        return {
          ok: true,
          json: async () => ({ prices: [[Date.UTC(2020, 0, 31, 12, 0), 30_000]] }),
        } as unknown as Response;
      }
      // Live unit price (step 3 revaluation).
      if (url.includes("api.coingecko.com")) {
        return {
          ok: true,
          json: async () => ({ bitcoin: { eur: 50_000 } }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const digest = await runAction(
      syncBinanceAction,
      form({ currentUrl: "/ajustes", sourceId }),
      store,
    );

    expect(digest).toContain("ok=binance_synced");

    // The backfill froze a binance row into the 2020-01-31 month-end snapshot at the
    // reconstructed gross: balance × that-day price = 0.5 × 30000 = 15000.00.
    const binanceRows = store.snapshots
      .readSnapshotHoldings({ holdingId: assetId })
      .filter((row) => row.kind === "asset" && row.dateKey === "2020-01-31");
    expect(binanceRows.length).toBeGreaterThan(0);
    const household = binanceRows.find((row) => row.scopeId === "mJ");
    expect(household?.valueMinor).toBe(15_000_00);
  });

  test("a Binance outage leaves existing positions untouched and surfaces an error", async () => {
    const store = createInMemoryStore();
    const { sourceId } = seedWithSource(store);
    store.connectedSources.syncPositions(
      sourceId,
      [
        {
          kind: "token",
          externalId: "BTC:spot",
          name: "BTC",
          symbol: "BTC",
          balance: "0.5",
          wallet: "spot",
          liquidityTier: "market",
          unitPrice: "50000",
          currency: "EUR",
        },
      ],
      "2026-06-16T10:00:00.000Z",
    );

    const fetchStub = vi.fn(
      async () => ({ ok: false, status: 401 }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchStub);

    const digest = await runAction(
      syncBinanceAction,
      form({ currentUrl: "/ajustes", sourceId }),
      store,
    );

    expect(digest).toContain("error=");
    expect(store.connectedSources.readPositions(sourceId)).toHaveLength(1);
  });
});
