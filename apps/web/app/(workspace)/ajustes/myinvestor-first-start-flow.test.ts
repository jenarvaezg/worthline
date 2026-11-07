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

import { portfolioWitnessView } from "@web/patrimonio/carteras/carteras-view";
import { loadCarteras } from "@web/patrimonio/carteras/load-carteras";
import { createStoreFromSqlite, openLibsqlClient } from "@worthline/db";
import { derivePosition, fixedClock } from "@worthline/domain";
import {
  createMyInvestorClient,
  type ResolveFxRateSnapshotOptions,
} from "@worthline/pricing";
import { fixtureTransport } from "@worthline/pricing/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

/** The same account with a robo-advisor that holds funds: the synthetic one (#1883). */
function roboClient(deviceId: string) {
  return createMyInvestorClient({
    deviceId,
    sleep: async () => {},
    transport: fixtureTransport({ prefer: (file) => file.includes("roboadvisor") }),
  });
}

/** A robo-advisor whose manager holds a fund in its USD class (#1899): synthetic. */
function roboUsdClient(deviceId: string) {
  return createMyInvestorClient({
    deviceId,
    sleep: async () => {},
    transport: fixtureTransport({ prefer: (file) => file.includes("roboadvisor-usd") }),
  });
}

/** The ECB, offline: one dollar is worth 0,90 € every day it is asked about. */
const ECB_AT_090: ResolveFxRateSnapshotOptions = {
  fetchDailyRates: async (_currency, fromMs, toMs) => {
    const rates = new Map<string, number>();
    for (let at = fromMs; at <= toMs; at += 86_400_000) {
      rates.set(new Date(at).toISOString().slice(0, 10), 0.9);
    }
    return rates;
  },
};

/** The ECB down: it answers no rate at all. */
const ECB_DOWN: ResolveFxRateSnapshotOptions = {
  fetchDailyRates: async () => new Map(),
};

async function connectAndRead(
  clientFor = fixtureClient,
  fx?: ResolveFxRateSnapshotOptions,
): Promise<string> {
  const step = await startMyInvestorConnect(
    {
      acceptedBy: null,
      afterConnect: ({ reader, sourceId }) =>
        storeMyInvestorDiscovery(
          { now: NOW, store, today: TODAY, ...(fx ? { fx } : {}) },
          { reader, sourceId },
        ),
      clientFor,
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
    const loaded = await loadMyInvestorFirstStart(store, sourceId, TODAY);

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
    // The robo-advisor is offered as ONE block (#1883); the captured one is empty —
    // no fund, no balance — so it is offered unticked.
    const managed = view.rows.filter((row) => row.kind === "managed");
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({ block: null, selectedByDefault: false });
    expect(isIncludable(managed[0]!)).toBe(true);
  });

  test("including everything of one's own: MyInvestor's units, one batch, nothing of the minor", async () => {
    const sourceId = await connectAndRead();
    const { view, discovery } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
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
      if (row.kind === "managed") {
        // The robo-advisor is a portfolio, not a holding: its cash is its member.
        const [portfolio] = await store.managedPortfolios.readManagedPortfolios();
        expect(portfolio?.name).toBe(row.name);
        continue;
      }
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
    const { view, discovery } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
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
    const { view } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
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

describe("linking a holding kept by hand (#1881), over the fixtures", () => {
  test("the twin opens set to link; confirming replaces its operations in one batch", async () => {
    const sourceId = await connectAndRead();
    const first = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const product = first.view.own
      .flatMap((group) => group.products)
      .find((row) => row.kind === "fund" && row.operations > 1)!;
    expect(product).toBeDefined();
    const discovered = first.discovery.products.find((row) => row.key === product.key)!;

    // The same fund, kept by hand with one buy of its own and a monthly plan.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "hand",
      instrument: "fund",
      liquidityTier: "market",
      name: "El fondo, a mano",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      securityId: { kind: "isin", value: discovered.instrument!.code },
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "hand",
        currency: "EUR",
        executedAt: "2024-01-17",
        feesMinor: 0,
        id: "hand-buy",
        kind: "buy",
        pricePerUnit: "27.3141",
        source: "manual",
        units: "1.7311",
      },
      { today: TODAY },
    );
    await store.contributionPlan.createPlannedContribution({
      amount: { mode: "money", value: 7_391 },
      cadence: { dayOfMonth: 17, kind: "monthly" },
      destinationHoldingId: "hand",
      scopeId: "default",
      startDate: "2024-01-17",
    });

    const { view } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const twin = view.rows.find((row) => row.key === product.key)!;
    expect(twin.twin?.reason).toBe("identifier");
    expect(twin.twin?.defaultChoice).toBe("link:hand");
    expect(twin.twin!.candidates[0]!.careo!.plan?.lines).toHaveLength(1);

    const batchesBefore = (await client.execute("SELECT id FROM fact_batch")).rows.length;
    const result = await includeMyInvestorProducts(
      {
        newAssetId: () => `asset_${++ids}`,
        resolveSymbol: async () => null,
        store,
        today: TODAY,
      },
      {
        links: [{ assetId: "hand", productKey: product.key }],
        productKeys: [],
        sourceId,
      },
    );

    expect(result).toMatchObject({ created: 0, linked: ["El fondo, a mano"], ok: true });
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(
      batchesBefore + 1,
    );
    expect(await linkedAssetFor(sourceId, product.key)).toBe("hand");
    // MyInvestor's units, exactly; the manual buy is provenance now.
    expect(Number(await unitsOf("hand"))).toBe(Number(product.units));
    const operations = await store.operations.readOperations("hand");
    expect(operations).toHaveLength(product.operations);
    expect(operations.some((operation) => operation.id === "hand-buy")).toBe(false);
    expect(
      (await store.connectedSources.readReplacedOperations("hand")).map(
        (row) => row.operation.id,
      ),
    ).toEqual(["hand-buy"]);
    const plan = await store.contributionPlan.readContributionPlan("default");
    expect(plan.contributions[0]!.endDate).toBe(TODAY);
  });
});

describe("the robo-advisor as a managed portfolio (#1883), over the fixtures", () => {
  const BLOCK = "portfolio:9100007";

  test("it creates the portfolio with its funds — the sold one too — and its cash; the witness squares", async () => {
    const sourceId = await connectAndRead(roboClient);
    const { view } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const row = view.rows.find((candidate) => candidate.key === BLOCK)!;
    expect(row).toMatchObject({
      kind: "managed",
      name: "CARTERA SINTETICA",
      selectedByDefault: true,
    });
    expect(row.portfolio!.declaredMinor).toBe(60_863);
    expect(
      row.portfolio!.members.map((member) => [member.identifier, member.soldByManager]),
    ).toEqual([
      ["IE00SINTET11", false],
      ["IE00SINTET29", false],
      ["LU00SINTET32", true],
    ]);

    const result = await include(sourceId, [BLOCK]);
    expect(result).toMatchObject({ created: 4, ok: true });
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(1);

    const [portfolio] = await store.managedPortfolios.readManagedPortfolios();
    expect(portfolio).toMatchObject({
      name: "CARTERA SINTETICA",
      provider: "MyInvestor",
      scopeId: "mJ",
      witness: {
        declaredDate: TODAY,
        declaredValue: { amountMinor: 60_863, currency: "EUR" },
      },
    });
    expect(portfolio!.holdingIds).toHaveLength(4);

    // MyInvestor's units, exactly; the fund the manager sold is a member at 0.
    const gold = await linkedAssetFor(sourceId, "securities:9100007|isin:IE00SINTET11");
    const copper = await linkedAssetFor(sourceId, "securities:9100007|isin:LU00SINTET32");
    const cash = await linkedAssetFor(sourceId, "cash:9100006");
    expect(Number(await unitsOf(gold!))).toBe(14.433);
    expect(Number(await unitsOf(copper!))).toBe(0);
    expect(
      (await store.operations.readOperations(copper!)).map((row) => row.kind),
    ).toEqual(["buy", "sell"]);
    expect(portfolio!.holdingIds).toEqual(expect.arrayContaining([gold, copper, cash]));
    expect(await store.managedPortfolios.readCashContainerName(cash!)).toBe(
      "CARTERA SINTETICA",
    );

    // The witness faces the funds alone, the cash left out (#1550), and squares.
    const model = await loadCarteras({
      baseCurrency: "EUR",
      scopeId: "mJ",
      store,
      today: TODAY,
    });
    const witness = portfolioWitnessView({
      baseCurrency: "EUR",
      moneyByHoldingId: model.moneyByHoldingId,
      portfolio: portfolio!,
      typeByHoldingId: model.typeByHoldingId,
    });
    expect(witness.cashMinor).toBe(583);
    expect(witness.declaredMinor).toBe(60_863);
    expect(witness.state).toBe("aligned");
  });

  test("a portfolio kept by hand is offered as a block and, confirmed, is linked whole", async () => {
    const sourceId = await connectAndRead(roboClient);
    const owner = [{ memberId: "mJ", shareBps: 10_000 }];
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "hand-rv",
      instrument: "fund",
      liquidityTier: "market",
      name: "Renta variable (a mano)",
      ownership: owner,
      securityId: { kind: "isin", value: "IE00SINTET11" },
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "hand-rv",
        currency: "EUR",
        executedAt: "2025-02-11",
        feesMinor: 0,
        id: "hand-buy",
        kind: "buy",
        pricePerUnit: "27.3262",
        source: "manual",
        units: "11.0213",
      },
      { today: TODAY },
    );
    const manual = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: owner,
      memberHoldingIds: ["hand-rv"],
      name: "Mi cartera indexada",
      provider: "MyInvestor",
      scopeId: "mJ",
    });
    const box = manual.holdingIds.find((id) => id !== "hand-rv")!;

    const { view } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const row = view.rows.find((candidate) => candidate.key === BLOCK)!;
    expect(row.selectedByDefault).toBe(false);
    expect(row.portfolioTwin?.defaultChoice).toBe(`link:${manual.id}`);
    const [candidate] = row.portfolioTwin!.candidates;
    expect(candidate!.blockers).toEqual([]);
    expect(candidate!.members.map((member) => member.assetId)).toEqual([
      "hand-rv",
      null,
      null,
    ]);
    // The same buy on both sides: it pairs, and MyInvestor brings the later one.
    expect(candidate!.members[0]!.careo!.counts).toMatchObject({
      enters: 1,
      manual: 1,
      same: 1,
    });

    const batchesBefore = (await client.execute("SELECT id FROM fact_batch")).rows.length;
    const result = await includeMyInvestorProducts(
      {
        newAssetId: () => `asset_${++ids}`,
        resolveSymbol: async () => null,
        store,
        today: TODAY,
      },
      { links: [{ assetId: manual.id, productKey: BLOCK }], productKeys: [], sourceId },
    );
    expect(result).toMatchObject({ linked: ["Mi cartera indexada"], ok: true });
    // The whole block — members, cash, new funds, witness — in ONE more batch.
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(
      batchesBefore + 1,
    );

    const [after] = await store.managedPortfolios.readManagedPortfolios();
    expect(after!.id).toBe(manual.id);
    expect(after!.holdingIds).toHaveLength(4);
    expect(after!.witness?.declaredValue.amountMinor).toBe(60_863);
    const assets = await store.assets.readAssets();
    const members = assets.filter((asset) => after!.holdingIds.includes(asset.id));
    expect(members.every((asset) => asset.connectedSourceId === sourceId)).toBe(true);
    expect(members.find((asset) => asset.id === box)!.currentValue.amountMinor).toBe(583);
    expect(Number(await unitsOf("hand-rv"))).toBe(14.433);
    expect(
      (await store.connectedSources.readReplacedOperations("hand-rv")).map(
        (entry) => entry.operation.id,
      ),
    ).toEqual(["hand-buy"]);
  });

  test("a manual member MyInvestor lacks blocks the link until it leaves the portfolio", async () => {
    const sourceId = await connectAndRead(roboClient);
    const owner = [{ memberId: "mJ", shareBps: 10_000 }];
    for (const [id, isin] of [
      ["hand-rv", "IE00SINTET11"],
      ["hand-other", "IE00SINTET94"],
    ] as const) {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id,
        instrument: "fund",
        liquidityTier: "market",
        name: `${id} (a mano)`,
        ownership: owner,
        securityId: { kind: "isin", value: isin },
      });
    }
    const manual = await store.managedPortfolios.createManagedPortfolio({
      containerOwnership: owner,
      memberHoldingIds: ["hand-rv", "hand-other"],
      name: "Mi cartera indexada",
      scopeId: "mJ",
    });

    const { view } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const row = view.rows.find((candidate) => candidate.key === BLOCK)!;
    expect(row.portfolioTwin!.candidates[0]!.blockers).toEqual(["hand-other (a mano)"]);
    expect(row.portfolioTwin!.candidates[0]!.href).toMatch(/^\/patrimonio\/carteras\//);
    expect(row.portfolioTwin!.defaultChoice).toBe("skip");

    const refused = await includeMyInvestorProducts(
      {
        newAssetId: () => `asset_${++ids}`,
        resolveSymbol: async () => null,
        store,
        today: TODAY,
      },
      { links: [{ assetId: manual.id, productKey: BLOCK }], productKeys: [], sourceId },
    );
    expect(refused.ok).toBe(false);
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(0);

    // Out of the portfolio, the link goes through.
    await store.managedPortfolios.updateManagedPortfolio(manual.id, {
      memberHoldingIds: ["hand-rv"],
    });
    const linked = await includeMyInvestorProducts(
      {
        newAssetId: () => `asset_${++ids}`,
        resolveSymbol: async () => null,
        store,
        today: TODAY,
      },
      { links: [{ assetId: manual.id, productKey: BLOCK }], productKeys: [], sourceId },
    );
    expect(linked.ok).toBe(true);
  });
});

describe("a robo-advisor with a fund in its USD class (#1899), over the fixtures", () => {
  const DOLLAR_ISIN = "IE00SINTET45";

  // Nothing here may reach the ECB: every rate comes from the fakes above.
  let network: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sin red"));
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });

  test("it is included whole: the dollar orders land in euros with their capture", async () => {
    const sourceId = await connectAndRead(roboUsdClient, ECB_AT_090);
    const { view, discovery } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const managed = view.rows.find((row) => row.kind === "managed")!;
    expect(managed).toMatchObject({ block: null, selectedByDefault: true });

    const result = await includeMyInvestorProducts(
      {
        newAssetId: () => `asset_${++ids}`,
        resolveSymbol: async () => null,
        store,
        today: TODAY,
      },
      { productKeys: [managed.key], sourceId },
    );
    expect(result.ok).toBe(true);

    const dollar = discovery.products.find(
      (product) => product.instrument?.code === DOLLAR_ISIN,
    )!;
    const assetId = (await linkedAssetFor(sourceId, dollar.key))!;
    const asset = (await store.assets.readAssets()).find((row) => row.id === assetId)!;
    expect(asset.currency).toBe("EUR");
    // P8: the units are MyInvestor's, exactly.
    expect(await unitsOf(assetId)).toBe(dollar.units);
    const operations = await store.operations.readOperations(assetId);
    expect(operations).toHaveLength(3);
    for (const operation of operations) {
      expect(operation.currency).toBe("EUR");
      expect(operation.capture).toMatchObject({ currency: "USD", eurPerUnit: 0.9 });
    }
    // 120,55 US$ for 12,2099 participaciones: the euro price is the dollar one × 0,90.
    const first = operations.find((row) => row.executedAt.startsWith("2025-03-10"))!;
    expect(Number(first.pricePerUnit)).toBeCloseTo(
      Number(first.capture!.pricePerUnit) * 0.9,
      8,
    );
    // The cost is in euros: never the 155,99 «€» the dollars sum to.
    const cost = derivePosition(operations, { assetId, currency: "EUR" }).costBasis;
    expect(cost.amountMinor).toBeLessThan(15_599);
  });

  test("the Conexiones page asks nothing of the network: the stored read brings the rates", async () => {
    const sourceId = await connectAndRead(roboUsdClient, ECB_AT_090);
    network.mockClear();
    const { view } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const managed = view.rows.find((row) => row.kind === "managed")!;
    expect(managed.block).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  test("with the ECB down at the read, the block waits: nothing is invented", async () => {
    const sourceId = await connectAndRead(roboUsdClient, ECB_DOWN);
    const { view } = (await loadMyInvestorFirstStart(store, sourceId, TODAY))!;
    const managed = view.rows.find((row) => row.kind === "managed")!;
    expect(managed.block).toEqual({ reason: "rate_missing" });
    expect(isIncludable(managed)).toBe(false);

    const refused = await includeMyInvestorProducts(
      {
        newAssetId: () => `asset_${++ids}`,
        resolveSymbol: async () => null,
        store,
        today: TODAY,
      },
      { productKeys: [managed.key], sourceId },
    );
    expect(refused.ok).toBe(false);
    expect(await store.assets.readAssets()).toHaveLength(0);
  });
});
