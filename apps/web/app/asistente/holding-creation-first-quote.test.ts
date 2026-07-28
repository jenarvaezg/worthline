import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import { confirmHoldingCreationProposalAction } from "./holding-creation-proposal-action";
import {
  buildHoldingCreationProposal,
  type HoldingCreationArgs,
} from "./holding-creation-proposals";

/**
 * The first quote of a chat-created holding (#1314). The confirm defers the provider
 * fetch past the response with `after()`, so these tests capture the deferred task
 * and run it explicitly — the only way to observe a write the response never waits
 * on. `withStore` is redirected to the in-memory store because the deferred pass
 * opens its OWN connection (the confirm's is closed by then).
 */
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

const TODAY = "2026-07-18";
const NOW = "2026-07-18T10:00:00Z";
const clock = { now: () => NOW, today: () => TODAY };

async function drainAfter(): Promise<void> {
  for (const task of afterTasks.splice(0)) {
    await task();
  }
}

async function seedWorkspace(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  currentStore = store;
  return store;
}

/** A Yahoo quote for whatever symbol is asked for. */
function stubYahoo(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            meta: { currency: "EUR", regularMarketPrice: 123.45 },
            timestamp: [Math.floor(Date.parse("2026-07-18T08:00:00Z") / 1000)],
            indicators: { quote: [{ close: [123.45] }] },
          },
        ],
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function confirmAlta(store: WorthlineStore, args: HoldingCreationArgs) {
  const built = await buildHoldingCreationProposal(store, args, TODAY);
  if (!built.ok) throw new Error(built.error);
  const result = await confirmHoldingCreationProposalAction(
    built.proposal.draft,
    store,
    clock,
  );
  expect(result).toEqual({ status: "applied" });
}

async function investmentIdOf(store: WorthlineStore, name: string): Promise<string> {
  const meta = (await store.assets.readInvestmentAssetsWithMeta()).find(
    (row) => row.name === name,
  );
  if (!meta) throw new Error(`no investment named ${name}`);
  return meta.id;
}

describe("first quote on a chat-created alta (#1314)", () => {
  afterEach(async () => {
    await drainAfter();
    vi.unstubAllGlobals();
    currentStore?.close();
    currentStore = null;
  });

  test("an alta with a symbol gets its price cached without waiting for the capture", async () => {
    const store = await seedWorkspace();
    stubYahoo();

    await confirmAlta(store, {
      family: "investment",
      instrument: "etf",
      name: "Vanguard S&P 500",
      openingValueMinor: 1_000_00,
      pricePerUnit: "100",
      providerSymbol: "VUSA.L",
    });
    const assetId = await investmentIdOf(store, "Vanguard S&P 500");

    // The confirm returned before the provider answered: the row lands with the
    // deferred pass, not inside the action.
    expect(await store.operations.readPriceCache(assetId)).toBeNull();
    await drainAfter();

    expect(await store.operations.readPriceCache(assetId)).toMatchObject({
      assetId,
      freshnessState: "fresh",
      price: "123.45",
    });
  });

  test("an alta without a symbol asks no provider anything", async () => {
    const store = await seedWorkspace();
    const fetchMock = stubYahoo();

    await confirmAlta(store, {
      family: "investment",
      instrument: "etf",
      name: "ETF sin símbolo",
      openingValueMinor: 1_000_00,
      pricePerUnit: "100",
    });
    await drainAfter();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await store.operations.readPriceCache(
        await investmentIdOf(store, "ETF sin símbolo"),
      ),
    ).toBeNull();
  });

  test("a provider outage leaves the alta applied and the quote marked failed", async () => {
    const store = await seedWorkspace();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("provider down");
      }),
    );

    await confirmAlta(store, {
      family: "investment",
      instrument: "etf",
      name: "ETF sin cotización",
      openingValueMinor: 1_000_00,
      pricePerUnit: "100",
      providerSymbol: "NOPE.L",
    });
    await drainAfter();

    const assetId = await investmentIdOf(store, "ETF sin cotización");
    expect(await store.operations.readPriceCache(assetId)).toMatchObject({
      assetId,
      freshnessState: "failed",
    });
  });
});
