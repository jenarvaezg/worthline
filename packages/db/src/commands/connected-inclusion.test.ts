/**
 * Including products of a source that owns its holdings (#1880, ADR 0115): the
 * holdings and their history land in ONE fact_batch, ONE transaction and ONE ripple
 * (ADR 0062), through the ingestion port's commit (ADR 0066), and only the source
 * writes into what it owns.
 */
import { openLibsqlClient } from "@worthline/db";
import { createStoreFromSqlite } from "@worthline/db/testing";
import type { CreateInvestmentOperationInput } from "@worthline/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const ripples = vi.hoisted(() => ({ calls: 0 }));

vi.mock("./ripple-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ripple-engine")>();
  return {
    ...original,
    rippleHistoricalSnapshotsForOperations: async (
      ...args: Parameters<typeof original.rippleHistoricalSnapshotsForOperations>
    ) => {
      ripples.calls += 1;
      return original.rippleHistoricalSnapshotsForOperations(...args);
    },
  };
});

const TODAY = "2026-11-04";
const OWNER = [{ memberId: "m", shareBps: 10_000 }];

type Client = ReturnType<typeof openLibsqlClient>;
type Store = Awaited<ReturnType<typeof createStoreFromSqlite>>;

let client: Client;
let store: Store;
let sourceId: string;

function buy(
  id: string,
  assetId: string,
  executedAt: string,
  units = "2",
): CreateInvestmentOperationInput {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit: "10",
    source: "connected",
    units,
  };
}

function fundHolding(productKey: string, id: string) {
  return {
    holding: {
      asset: {
        currency: "EUR",
        id,
        instrument: "fund" as const,
        liquidityTier: "market" as const,
        name: id,
        ownership: OWNER,
        securityId: { kind: "isin" as const, value: "IE00B03HD191" },
      },
      kind: "investment" as const,
    },
    productKey,
  };
}

function facts(operations: CreateInvestmentOperationInput[], cursor = TODAY) {
  return {
    cursor,
    facts: operations.map((operation) => ({
      dateKey: operation.executedAt,
      key: `fact:${operation.id}`,
      payload: operation,
    })),
  };
}

beforeEach(async () => {
  ripples.calls = 0;
  client = openLibsqlClient(":memory:");
  store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Titular" }],
    mode: "individual",
  });
  const connected = await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: "{}",
    label: "MyInvestor",
  });
  sourceId = connected!.sourceId;
});

describe("including connected holdings", () => {
  test("two holdings and their history: one batch, one ripple, born linked", async () => {
    const result = await store.command.includeConnectedHoldings({
      facts: facts([
        buy("o1", "f1", "2025-01-10"),
        buy("o2", "f1", "2025-06-10"),
        buy("o3", "f2", "2025-03-10"),
      ]),
      holdings: [fundHolding("p1", "f1"), fundHolding("p2", "f2")],
      sourceId,
      today: TODAY,
    });

    expect(result).toEqual({ applied: 3, created: 2, linked: 0 });
    expect(ripples.calls).toBe(1);
    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("connect");
    expect(
      (await client.execute("SELECT DISTINCT batch_id FROM asset_operations")).rows,
    ).toEqual([{ batch_id: batches.rows[0]!.id }]);
    expect(await store.connectedSources.readLinks(sourceId)).toEqual([
      { assetId: "f1", productKey: "p1" },
      { assetId: "f2", productKey: "p2" },
    ]);
    expect(await store.connectedSources.readAppliedFactKeys(sourceId)).toEqual(
      new Set(["fact:o1", "fact:o2", "fact:o3"]),
    );
    const source = await client.execute(
      "SELECT ingest_cursor FROM connected_sources WHERE id = ?",
      [sourceId],
    );
    expect(source.rows[0]!.ingest_cursor).toBe(TODAY);
    // The snapshots the ripple generated carry the history.
    expect(
      (await client.execute("SELECT DISTINCT date_key FROM snapshots")).rows.length,
    ).toBeGreaterThan(0);

    // A linked holding refuses a hand-written operation (ADR 0115, decision 2).
    await expect(
      store.operations.recordOperations([buy("hand", "f1", "2025-07-01")]),
    ).rejects.toThrow();
  });

  test("a product already linked is refused, and nothing of the second try lands", async () => {
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "f1", "2025-01-10")]),
      holdings: [fundHolding("p1", "f1")],
      sourceId,
      today: TODAY,
    });

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([buy("o9", "f9", "2025-01-10")]),
        holdings: [fundHolding("p1", "f9")],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/already linked/);
    expect((await client.execute("SELECT id FROM fact_batch")).rows).toHaveLength(1);
    expect((await client.execute("SELECT id FROM assets WHERE id = 'f9'")).rows).toEqual(
      [],
    );
  });

  test("a fact already applied is not applied twice; the cursor never goes back", async () => {
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "f1", "2025-01-10")]),
      holdings: [fundHolding("p1", "f1")],
      sourceId,
      today: TODAY,
    });

    const replay = await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "f1", "2025-01-10")], "2026-01-01"),
      holdings: [],
      sourceId,
      today: TODAY,
    });

    expect(replay).toEqual({ applied: 0, created: 0, linked: 0 });
    expect((await store.operations.readOperations("f1")).length).toBe(1);
    const source = await client.execute(
      "SELECT ingest_cursor FROM connected_sources WHERE id = ?",
      [sourceId],
    );
    expect(source.rows[0]!.ingest_cursor).toBe(TODAY);
  });

  test("the source cannot write into a holding it does not own", async () => {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "manual",
      liquidityTier: "market",
      name: "A mano",
      ownership: OWNER,
    });

    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([buy("o1", "manual", "2025-01-10")]),
        holdings: [],
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/not linked/);
    expect(await store.operations.readOperations("manual")).toEqual([]);
  });

  test("a mirroring source cannot include", async () => {
    await expect(
      store.command.includeConnectedHoldings({
        facts: facts([]),
        holdings: [],
        sourceId: "unknown",
        today: TODAY,
      }),
    ).rejects.toThrow(/does not own/);
  });

  test("an export carries the links, the ledger, the cursor and the last read back", async () => {
    await store.connectedSources.saveDiscovery({
      payloadJson: '{"version":1}',
      readAt: `${TODAY}T09:00:00.000Z`,
      readOn: TODAY,
      sourceId,
    });
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "f1", "2025-01-10")]),
      holdings: [fundHolding("p1", "f1")],
      sourceId,
      today: TODAY,
    });

    const doc = await store.workspace.exportWorkspace();
    const restored = await createStoreFromSqlite(openLibsqlClient(":memory:"));
    await restored.workspace.importWorkspace(doc);

    expect(await restored.connectedSources.readLinks(sourceId)).toEqual([
      { assetId: "f1", productKey: "p1" },
    ]);
    expect(await restored.connectedSources.readAppliedFactKeys(sourceId)).toEqual(
      new Set(["fact:o1"]),
    );
    expect(await restored.connectedSources.readDiscovery(sourceId)).toEqual({
      payloadJson: '{"version":1}',
      readOn: TODAY,
    });
    expect(doc.connectedSources[0]!.ingestCursor).toBe(TODAY);
  });

  test("a read is kept on a calendar day, never an instant", async () => {
    await expect(
      store.connectedSources.saveDiscovery({
        payloadJson: "{}",
        readAt: `${TODAY}T09:00:00.000Z`,
        readOn: `${TODAY}T09:00:00.000Z`,
        sourceId,
      }),
    ).rejects.toThrow(/calendar day/);
  });
});

/** A cash account linked to the source, as the first start creates it (#1869 P4). */
function cashHolding(productKey: string, id: string, currentValueMinor: number) {
  return {
    holding: {
      asset: {
        currency: "EUR",
        currentValueMinor,
        id,
        instrument: "current_account" as const,
        liquidityTier: "cash" as const,
        name: id,
        ownership: OWNER,
        type: "cash" as const,
      },
      kind: "cash" as const,
    },
    productKey,
  };
}

describe("a periodic sync of the linked holdings (#1884)", () => {
  test("the new operations and the cash balances land in ONE sync batch", async () => {
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "f1", "2025-01-10")], "2026-10-01"),
      holdings: [fundHolding("p1", "f1"), cashHolding("c1", "cash1", 10_001)],
      sourceId,
      today: TODAY,
    });
    ripples.calls = 0;

    const result = await store.command.syncConnectedHoldings({
      cashBalances: [{ assetId: "cash1", valueMinor: 23_457 }],
      // The window overlaps the last good sync: o1 comes again and is not applied twice.
      facts: facts([buy("o1", "f1", "2025-01-10"), buy("o2", "f1", "2026-10-20")]),
      sourceId,
      today: TODAY,
    });

    expect(result).toEqual({ applied: 1 });
    expect(ripples.calls).toBe(1);
    expect((await store.operations.readOperations("f1")).map((row) => row.id)).toEqual([
      "o1",
      "o2",
    ]);
    const batches = await client.execute("SELECT trigger FROM fact_batch ORDER BY rowid");
    expect(batches.rows.map((row) => row.trigger)).toEqual(["connect", "sync"]);
    const cash = await client.execute(
      "SELECT current_value_minor FROM assets WHERE id = 'cash1'",
    );
    expect(cash.rows[0]!.current_value_minor).toBe(23_457);
    const source = await client.execute(
      "SELECT ingest_cursor FROM connected_sources WHERE id = ?",
      [sourceId],
    );
    expect(source.rows[0]!.ingest_cursor).toBe(TODAY);
  });

  test("a sync never writes a balance into a holding it does not own", async () => {
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 5_003,
      id: "own-cash",
      instrument: "current_account",
      liquidityTier: "cash",
      name: "A mano",
      ownership: OWNER,
      type: "cash",
    });

    await expect(
      store.command.syncConnectedHoldings({
        cashBalances: [{ assetId: "own-cash", valueMinor: 1 }],
        facts: facts([]),
        sourceId,
        today: TODAY,
      }),
    ).rejects.toThrow(/not linked/);
    const cash = await client.execute(
      "SELECT current_value_minor FROM assets WHERE id = 'own-cash'",
    );
    expect(cash.rows[0]!.current_value_minor).toBe(5_003);
  });

  test("the units check reads every linked ledger at once, each in its own order", async () => {
    await store.command.includeConnectedHoldings({
      facts: facts([
        buy("o2", "f1", "2025-06-10"),
        buy("o1", "f1", "2025-01-10"),
        buy("o3", "f2", "2025-03-10"),
      ]),
      holdings: [fundHolding("p1", "f1"), fundHolding("p2", "f2")],
      sourceId,
      today: TODAY,
    });

    const ledgers = await store.operations.readHoldingLedgers(["f1", "f2"]);

    expect(ledgers.get("f1")!.operations.map((row) => row.id)).toEqual(["o1", "o2"]);
    expect(ledgers.get("f2")!.operations.map((row) => row.id)).toEqual(["o3"]);
  });

  test("the dedup ledger is read only for the keys of the batch", async () => {
    await store.command.includeConnectedHoldings({
      facts: facts([buy("o1", "f1", "2025-01-10"), buy("o2", "f1", "2025-02-10")]),
      holdings: [fundHolding("p1", "f1")],
      sourceId,
      today: TODAY,
    });

    expect(
      await store.connectedSources.readAppliedFactKeys(sourceId, ["fact:o2", "fact:o7"]),
    ).toEqual(new Set(["fact:o2"]));
  });
});
