import type { RunDailyCaptureDeps, WorthlineStore } from "@worthline/db";

import { createInMemoryStore } from "@worthline/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const NOW = "2026-06-25T21:00:00.000Z";
const TODAY = "2026-06-25";

// Inject fake deps so the route's real secret gate + real `runDailyCapture`
// wiring run without control plane, Turso, or network.
const { captureDeps } = vi.hoisted(() => {
  const deps: RunDailyCaptureDeps = {
    now: "2026-06-25T21:00:00.000Z",
    listAllWorkspaces: async () => [],
    openStore: async () => {
      throw new Error("no workspaces to open");
    },
    fetchPrices: async () => [],
  };
  return { captureDeps: deps };
});

vi.mock("./daily-capture-deps", () => ({
  buildDailyCaptureDeps: () => captureDeps,
}));

import { GET } from "./route";

const URL = "http://localhost:3000/api/cron/snapshot";
const SECRET = "s3cr3t";

function keepOpen(store: WorthlineStore): WorthlineStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "close") return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function seededMarketStore(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fund",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    priceProvider: "yahoo",
    providerSymbol: "AAPL",
  });
  await store.command.recordInvestmentOperation(
    {
      assetId: "fund",
      currency: "EUR",
      executedAt: "2026-01-01",
      feesMinor: 0,
      id: "op_fund",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    },
    { today: TODAY },
  );
  return store;
}

describe("/api/cron/snapshot", () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    captureDeps.listAllWorkspaces = async () => [];
    captureDeps.openStore = async () => {
      throw new Error("no workspaces to open");
    };
    captureDeps.fetchPrices = async () => [];
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  test("rejects a request with no Authorization (401)", async () => {
    const res = await GET(new Request(URL));
    expect(res.status).toBe(401);
  });

  test("rejects a wrong bearer secret (401)", async () => {
    const res = await GET(
      new Request(URL, { headers: { Authorization: "Bearer wrong" } }),
    );
    expect(res.status).toBe(401);
  });

  test("with the secret, runs the capture and returns a summary (200)", async () => {
    const res = await GET(
      new Request(URL, { headers: { Authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 0, captured: 0, failures: [] });
  });

  test("with a seeded workspace, captures priced holdings through the route (200)", async () => {
    const seeded = await seededMarketStore();
    captureDeps.listAllWorkspaces = async () => [{ id: "ws", dbUrl: "libsql://ws" }];
    captureDeps.openStore = async () => keepOpen(seeded);
    captureDeps.fetchPrices = async () => [
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

    const res = await GET(
      new Request(URL, { headers: { Authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 1, captured: 1, failures: [] });

    const snapshot = (await seeded.snapshots.readSnapshots("household")).find(
      (row) => row.dateKey === TODAY,
    );
    expect(snapshot?.grossAssets.amountMinor).toBe(2_500_00);

    seeded.close();
  });

  test("fails closed when CRON_SECRET is unset (401 even with a bearer)", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(
      new Request(URL, { headers: { Authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(401);
  });
});
