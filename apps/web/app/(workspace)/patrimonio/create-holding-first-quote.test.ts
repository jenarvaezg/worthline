/**
 * The first quote of a wizard-created holding (#1314). The «Añadir holding» alta
 * defers the provider fetch past the response with `after()`, so these tests
 * capture the deferred task and run it explicitly — the only way to observe a
 * write the redirect never waits on. `withStore` is redirected to the in-memory
 * store because the deferred pass opens its OWN connection (the action's is
 * closed by then). Kept apart from `create-holding-action.test.ts` so those
 * store-state assertions never see the mocked module graph.
 */

import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createHoldingAction } from "./create-holding-action";

const afterTasks: (() => unknown)[] = [];

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
}));

let currentStore: WorthlineStore | null = null;

vi.mock("@web/store", () => ({
  withStore: <T>(run: (store: WorthlineStore) => Promise<T>) => run(currentStore!),
}));

vi.mock("@web/demo/write-guard", () => ({
  guardDemoWrite: vi.fn(async () => undefined),
}));

const CLOCK = fixedClock("2026-06-15");

async function drainAfter(): Promise<void> {
  for (const task of afterTasks.splice(0)) {
    await task();
  }
}

async function seedStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  currentStore = store;
  return store;
}

/** Post the alta form (the action always redirects) and return the created id. */
async function addStock(store: WorthlineStore, symbol?: string): Promise<string> {
  const fd = new FormData();
  fd.set("instrument", "stock");
  fd.set("name_stock", "Apple");
  fd.set("ownershipPreset", "scope");
  fd.set("scopeMemberId", "mJ");
  if (symbol) {
    fd.set("symbol_stock", symbol);
  }
  try {
    await createHoldingAction(fd, store, CLOCK);
    throw new Error("action did not redirect");
  } catch (error: unknown) {
    const redirected = error as { message?: string };
    if (redirected.message !== "NEXT_REDIRECT") throw error;
  }
  const meta = await store.assets.readInvestmentAssetsWithMeta();
  return meta[0]!.id;
}

describe("first quote on a wizard-created alta (#1314)", () => {
  afterEach(async () => {
    await drainAfter();
    vi.unstubAllGlobals();
    currentStore?.close();
    currentStore = null;
  });

  test("an alta with a symbol gets its price cached without waiting for the capture", async () => {
    const store = await seedStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: { currency: "EUR", regularMarketPrice: 210.5 },
                timestamp: [Math.floor(Date.parse("2026-06-15T08:00:00Z") / 1000)],
                indicators: { quote: [{ close: [210.5] }] },
              },
            ],
          },
        }),
      })),
    );

    const assetId = await addStock(store, "AAPL");

    expect(await store.operations.readPriceCache(assetId)).toBeNull();
    await drainAfter();

    expect(await store.operations.readPriceCache(assetId)).toMatchObject({
      assetId,
      freshnessState: "fresh",
      price: "210.5",
    });
  });

  test("an alta without a symbol asks no provider anything", async () => {
    const store = await seedStore();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const assetId = await addStock(store);
    await drainAfter();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.operations.readPriceCache(assetId)).toBeNull();
  });
});
