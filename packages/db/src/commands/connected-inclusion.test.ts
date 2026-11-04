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
