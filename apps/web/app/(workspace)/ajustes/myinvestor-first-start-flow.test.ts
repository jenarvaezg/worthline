/**
 * The first start of MyInvestor end to end (#1880, acceptance): an empty workspace
 * connects, worthline reads the account, and including everything creates linked
 * holdings whose units are MyInvestor's, in ONE fact_batch. The client is the real
 * one over the anonymized fixtures of #1887; nothing reaches the network.
 *
 * - What belongs to someone else (`REPRESENTATIVE`, a minor's account) arrives
 *   unticked and does not touch the patrimonio; including it later creates it with
 *   its history.
 * - The cash account counts what is held for an order in progress once: inside its
 *   balance, and never as an operation of the plan the order is for (#1869 P4).
 */
import { createStoreFromSqlite, openLibsqlClient } from "@worthline/db";
import { derivePosition, fixedClock } from "@worthline/domain";
import { createMyInvestorClient } from "@worthline/pricing";
import { fixtureTransport } from "@worthline/pricing/testing";
import { beforeEach, describe, expect, test } from "vitest";

import { startMyInvestorConnect } from "./myinvestor-connect";
import {
  includeMyInvestorProducts,
  loadMyInvestorFirstStart,
  storeMyInvestorDiscovery,
} from "./myinvestor-first-start-flow";
import { isIncludable } from "./myinvestor-selection";

/** The day the fixtures were captured: the `dateTo` their manifest records. */
const TODAY = "2026-11-04";
const NOW = `${TODAY}T09:00:00.000Z`;

type Store = Awaited<ReturnType<typeof createStoreFromSqlite>>;

let client: ReturnType<typeof openLibsqlClient>;
let store: Store;
let ids = 0;

function fixtureClient(deviceId: string) {
  return createMyInvestorClient({
    deviceId,
    sleep: async () => {},
    transport: fixtureTransport(),
  });
}

async function connectAndRead(): Promise<string> {
  const step = await startMyInvestorConnect(
    {
      acceptedBy: null,
      afterConnect: ({ reader, sourceId }) =>
        storeMyInvestorDiscovery({ now: NOW, store, today: TODAY }, { reader, sourceId }),
      clientFor: fixtureClient,
      newDeviceId: () => "device-sintetico",
      now: NOW,
      store: store.connectedSources,
    },
    { customerId: "00000000A", password: "sintetica", save: false },
  );
  expect(step.step).toBe("connected");
  const source = (await store.connectedSources.listSources()).find(
    (row) => row.adapter === "myinvestor",
  );
  return source!.id;
}

function include(sourceId: string, productKeys: readonly string[]) {
  return includeMyInvestorProducts(
    {
      newAssetId: () => `asset_${++ids}`,
      resolveSymbol: async () => null,
      store,
      today: TODAY,
    },
    { productKeys, sourceId },
  );
}

async function unitsOf(assetId: string): Promise<string> {
  const operations = await store.operations.readOperations(assetId);
  return derivePosition(operations, { assetId, currency: "EUR" }).currentUnits;
}

async function linkedAssetFor(sourceId: string, productKey: string) {
  const links = await store.connectedSources.readLinks(sourceId);
  return links.find((link) => link.productKey === productKey)?.assetId ?? null;
}

async function patrimonioMinor(): Promise<number> {
  return (await store.assets.readAssets()).reduce(
    (sum, asset) => sum + asset.currentValue.amountMinor,
    0,
  );
}

beforeEach(async () => {
  ids = 0;
  client = openLibsqlClient(":memory:");
  store = await createStoreFromSqlite(client, { clock: fixedClock(NOW) });
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
});

describe("the first start of MyInvestor, over the fixtures", () => {
  test("connecting reads the account: own products ticked, someone else's not", async () => {
    const sourceId = await connectAndRead();
    const loaded = await loadMyInvestorFirstStart(store, sourceId);

    expect(loaded).not.toBeNull();
    const { view } = loaded!;
    expect(view.own.length).toBeGreaterThan(0);
    expect(view.others.length).toBeGreaterThan(0);
    for (const group of view.others) {
      for (const row of group.products) {
        expect(row.otherHolder).toBe(true);
        expect(row.selectedByDefault).toBe(false);
      }
    }
    // The robo-advisor is offered as ONE block, and not yet (#1883).
    const managed = view.rows.filter((row) => row.kind === "managed");
    expect(managed).toHaveLength(1);
    expect(managed[0]!.block).toEqual({ reason: "managed_portfolio" });
  });

  test("including everything of one's own: MyInvestor's units, one batch, nothing of the minor", async () => {
    const sourceId = await connectAndRead();
    const { view, discovery } = (await loadMyInvestorFirstStart(store, sourceId))!;
    const own = view.own.flatMap((group) => group.products).filter(isIncludable);

    const result = await include(
      sourceId,
      own.map((row) => row.key),
    );
    expect(result.ok).toBe(true);

    const batches = await client.execute(
      "SELECT id, trigger, connected_source_id FROM fact_batch",
    );
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("connect");
    expect(batches.rows[0]!.connected_source_id).toBe(sourceId);
    const operationBatches = await client.execute(
      "SELECT DISTINCT batch_id FROM asset_operations",
    );
    expect(operationBatches.rows).toEqual([{ batch_id: batches.rows[0]!.id }]);

    for (const row of own) {
      const assetId = await linkedAssetFor(sourceId, row.key);
      expect(assetId, row.key).not.toBeNull();
      const product = discovery.products.find((candidate) => candidate.key === row.key)!;
      if (product.units !== null) {
        expect(Number(await unitsOf(assetId!)), row.key).toBe(Number(product.units));
      }
      expect((await store.operations.readOperations(assetId!)).length).toBe(
        row.operations,
      );
    }

    // Every holding is born linked, and nothing of the minor's account exists.
    const assets = await store.assets.readAssets();
    expect(assets).toHaveLength(own.length);
    expect(assets.every((asset) => asset.connectedSourceId === sourceId)).toBe(true);
    for (const row of view.others.flatMap((group) => group.products)) {
      expect(await linkedAssetFor(sourceId, row.key)).toBeNull();
    }

    // A replay of the same choice creates nothing more.
    const again = await include(
      sourceId,
      own.map((row) => row.key),
    );
    expect(again.ok).toBe(false);
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(1);
  });

  test("the cash with an order in progress counts the held amount once", async () => {
    const sourceId = await connectAndRead();
    const { view, discovery } = (await loadMyInvestorFirstStart(store, sourceId))!;
    const cash = view.own
      .flatMap((group) => group.products)
      .find((row) => row.kind === "cash" && row.withheldMinor !== null)!;
    expect(cash).toBeDefined();
    const product = discovery.products.find((candidate) => candidate.key === cash.key)!;

    // The API's available balance leaves the hold out; the hold is the in-progress
    // order's block. The balance worthline keeps is the two, once.
    expect(cash.withheldMinor).toBeGreaterThan(0);
    expect(cash.valueMinor).toBeGreaterThan(cash.withheldMinor!);
    expect(product.cash!.balance).not.toBe(product.cash!.withheld);

    // The order the hold is for — the plan contribution still in progress on the
    // capture's last working day — is not finished, so it is no operation of the plan.
    const inProgress = discovery.operations.filter(
      (fact) =>
        fact.payload.product === "pension_plan" &&
        fact.payload.executedAt === "2026-11-02",
    );
    expect(inProgress).toHaveLength(0);

    const before = await patrimonioMinor();
    expect((await include(sourceId, [cash.key])).ok).toBe(true);
    expect((await patrimonioMinor()) - before).toBe(cash.valueMinor);
  });

  test("what belongs to someone else stays out, and including it later brings its history", async () => {
    const sourceId = await connectAndRead();
    const { view } = (await loadMyInvestorFirstStart(store, sourceId))!;
    const own = view.own.flatMap((group) => group.products).filter(isIncludable);
    await include(
      sourceId,
      own.map((row) => row.key),
    );
    const withoutMinor = await patrimonioMinor();

    const minor = view.others
      .flatMap((group) => group.products)
      .filter(isIncludable)
      .find((row) => row.kind !== "cash" && row.operations > 0)!;
    expect(minor).toBeDefined();
    expect(await linkedAssetFor(sourceId, minor.key)).toBeNull();

    expect((await include(sourceId, [minor.key])).ok).toBe(true);
    const assetId = await linkedAssetFor(sourceId, minor.key);
    expect(assetId).not.toBeNull();
    expect((await store.operations.readOperations(assetId!)).length).toBe(
      minor.operations,
    );
    expect(Number(await unitsOf(assetId!))).toBe(Number(minor.units));
    expect(await patrimonioMinor()).toBe(withoutMinor + minor.valueMinor);
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(2);
  });
});
