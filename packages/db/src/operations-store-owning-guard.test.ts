/**
 * Invariant 5 of PRD #1876: a holding a connected source owns takes no operation
 * written — or REMOVED — by hand. The guard lives in the store, not in the web
 * action, because the assistant writes below the Server Actions: a POST carrying an
 * `operationId`, or a tool call, reaches `deleteOperation` / `deleteTransferPair`
 * directly.
 */
import { openLibsqlClient } from "@worthline/db";
import { createStoreFromSqlite } from "@worthline/db/testing";
import { beforeEach, describe, expect, test } from "vitest";

const TODAY = "2026-11-04";
const OWNER = [{ memberId: "m", shareBps: 10_000 }];

type Client = ReturnType<typeof openLibsqlClient>;
type Store = Awaited<ReturnType<typeof createStoreFromSqlite>>;

let client: Client;
let store: Store;

async function fund(id: string) {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id,
    instrument: "fund",
    liquidityTier: "market",
    name: id,
    ownership: OWNER,
  });
}

/** Hand the holding to the source the way the link does, without the link's batch. */
async function ownBySource(assetId: string) {
  const connected = await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: "{}",
    label: "MyInvestor",
  });
  await client.execute({
    args: [connected!.sourceId, assetId],
    sql: "UPDATE assets SET connected_source_id = ? WHERE id = ?",
  });
}

beforeEach(async () => {
  client = openLibsqlClient(":memory:");
  store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Titular" }],
    mode: "individual",
  });
});

describe("deleting an operation of a holding a source owns", () => {
  test("deleteOperation refuses, and the row stays", async () => {
    await fund("owned");
    await store.operations.recordOperation({
      assetId: "owned",
      currency: "EUR",
      executedAt: "2025-03-07",
      feesMinor: 0,
      id: "op-owned",
      kind: "buy",
      pricePerUnit: "27.4139",
      units: "3.0317",
    });
    await ownBySource("owned");

    await expect(store.operations.deleteOperation("op-owned")).rejects.toThrow();
    await expect(
      store.command.deleteInvestmentOperation({ operationId: "op-owned", today: TODAY }),
    ).rejects.toThrow();

    expect((await store.operations.readOperations("owned")).map((op) => op.id)).toEqual([
      "op-owned",
    ]);
  });

  test("deleting the manual half of a traspaso into an owned holding takes neither leg", async () => {
    await fund("hand");
    await fund("owned");
    await store.operations.recordOperation({
      assetId: "hand",
      currency: "EUR",
      executedAt: "2025-03-07",
      feesMinor: 0,
      id: "op-out",
      kind: "transfer_out",
      pricePerUnit: "27.4139",
      transferId: "trf-1",
      units: "3.0317",
    });
    await store.operations.recordOperation({
      assetId: "owned",
      currency: "EUR",
      executedAt: "2025-03-07",
      feesMinor: 0,
      id: "op-in",
      kind: "transfer_in",
      pricePerUnit: "27.4139",
      transferCostMinor: 8_311,
      transferId: "trf-1",
      units: "3.0317",
    });
    await ownBySource("owned");

    await expect(store.operations.deleteTransferPair("trf-1")).rejects.toThrow();
    await expect(
      store.command.deleteInvestmentTransfer({ today: TODAY, transferId: "trf-1" }),
    ).rejects.toThrow();

    expect((await store.operations.readOperations("hand")).map((op) => op.id)).toEqual([
      "op-out",
    ]);
    expect((await store.operations.readOperations("owned")).map((op) => op.id)).toEqual([
      "op-in",
    ]);
  });

  test("a manual holding still deletes its own rows", async () => {
    await fund("hand");
    await store.operations.recordOperation({
      assetId: "hand",
      currency: "EUR",
      executedAt: "2025-03-07",
      feesMinor: 0,
      id: "op-hand",
      kind: "buy",
      pricePerUnit: "27.4139",
      units: "3.0317",
    });

    await store.operations.deleteOperation("op-hand");

    expect(await store.operations.readOperations("hand")).toEqual([]);
  });
});
