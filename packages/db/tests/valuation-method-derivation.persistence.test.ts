/**
 * `assets.valuation_method` is a DEAD column (#1680).
 *
 * The method a holding is configured by has exactly one derivation — its
 * instrument's defaults (ADR 0014, `valuationMethodOfAsset`). Three seams used to
 * decide with the stored column instead, falling back to the pre-ADR-0014
 * `AssetType` mapping when it was NULL: the balance-reconciliation guard, the
 * document export, and the document import.
 *
 * The row that surfaced it in a real workspace was a «Colección Numista» — a
 * connected coin collection, whose value is derived from its positions (ADR 0016)
 * and can never be hand-set — carrying `valuation_method = 'stored'`. It walked
 * through the guard that exists to let only declared-value destinations in.
 */

import { openLibsqlClient } from "@db/index";
import { createStoreFromSqlite, type PersistenceTestStore } from "@db/testing";
import type { Client } from "@libsql/client";
import type { WorkspaceExport } from "@worthline/domain";
import { serializeWorkspaceExport } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

const MEMBER_ID = "m1";

let client: Client;
let store: PersistenceTestStore;

afterEach(() => {
  // `store.close()` closes the client it was built on; the handle is nulled so a
  // test that never seeded cannot close a stale one.
  store?.close();
});

/** Seed a workspace and expose the raw client the rotten-column fixtures need. */
async function freshStore(): Promise<PersistenceTestStore> {
  client = openLibsqlClient(":memory:");
  store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  return store;
}

const storedMethodOf = async (assetId: string): Promise<string | null> =>
  (
    (
      await client.execute({
        args: [assetId],
        sql: "SELECT valuation_method AS m FROM assets WHERE id = ?",
      })
    ).rows[0] as unknown as { m: string | null }
  ).m;

describe("balance reconciliation — the destination's method comes from its instrument", () => {
  test("rejects a coin collection whose stored column still says `stored`", async () => {
    await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 50_000,
      id: "coleccion",
      liquidityTier: "illiquid",
      name: "Colección Numista",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      type: "manual",
    });
    // Exactly the shape found in the real workspace: instrument `coin_collection`
    // (method `derived`, ADR 0016) with a stale `stored` on the dead column. The
    // connected-source link is what makes it a live collection in production; the
    // guard's decision never depended on it, so the fixture pins the instrument
    // alone and no downstream guard can mask the rejection under test.
    await client.execute({
      args: ["coleccion"],
      sql: "UPDATE assets SET instrument = 'coin_collection', valuation_method = 'stored' WHERE id = ?",
    });

    const contribution = await store.contributionPlan.createPlannedContribution({
      amount: { mode: "money", value: 100_00 },
      cadence: { dayOfMonth: 1, kind: "monthly" },
      destinationHoldingId: "coleccion",
      scopeId: "default",
      startDate: "2026-01-01",
    });

    await expect(
      store.command.applyStoredContributionValue({
        assetId: "coleccion",
        contributionId: contribution.id,
        executedMinor: 100_00,
        newValueMinor: 60_000,
        occurrenceId: `${contribution.id}:2026-01-01`,
      }),
    ).rejects.toThrow(/stored-value/i);
  });

  test("still admits a cash account whose column was never backfilled", async () => {
    await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000,
      id: "cuenta",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      type: "cash",
    });
    await client.execute("UPDATE assets SET valuation_method = NULL WHERE id = 'cuenta'");

    const contribution = await store.contributionPlan.createPlannedContribution({
      amount: { mode: "money", value: 100_00 },
      cadence: { dayOfMonth: 1, kind: "monthly" },
      destinationHoldingId: "cuenta",
      scopeId: "default",
      startDate: "2026-01-01",
    });

    await store.command.applyStoredContributionValue({
      assetId: "cuenta",
      contributionId: contribution.id,
      executedMinor: 100_00,
      newValueMinor: 110_000,
      occurrenceId: `${contribution.id}:2026-01-01`,
    });

    const asset = (await store.assets.readAssets()).find((a) => a.id === "cuenta")!;
    expect(asset.currentValue.amountMinor).toBe(110_000);
  });
});

/** A one-asset document declaring a method that contradicts its own instrument. */
function makeContradictoryDocument(): WorkspaceExport {
  return serializeWorkspaceExport({
    assets: [
      {
        currency: "EUR",
        currentValue: { amountMinor: 50_000, currency: "EUR" },
        id: "doc-coleccion",
        instrument: "coin_collection",
        isPrimaryResidence: false,
        liquidityTier: "illiquid",
        name: "Colección Numista",
        ownership: [{ memberId: "doc-m1", shareBps: 10_000 }],
        type: "manual",
        // The contradiction a hand-rolled file can carry — and what a pre-#1680
        // export wrote verbatim out of the rotten column.
        valuationMethod: "stored",
      },
    ],
    connectedSources: [],
    fireConfig: {},
    groups: [],
    liabilities: [],
    members: [{ id: "doc-m1", name: "Documento" }],
    operations: [],
    priceCache: [],
    snapshots: [],
    trash: { assets: [], liabilities: [] },
    warningOverrides: [],
    workspace: { baseCurrency: "EUR", mode: "individual" },
  });
}

describe("workspace document — the method is derived on both sides", () => {
  test("an imported document cannot plant a method that contradicts its instrument", async () => {
    await freshStore();

    await store.workspace.importWorkspace(makeContradictoryDocument());

    expect(await storedMethodOf("doc-coleccion")).toBe("derived");
  });

  test("the export derives the method, so a rotten column never reaches the file", async () => {
    await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 50_000,
      id: "coleccion",
      liquidityTier: "illiquid",
      name: "Colección Numista",
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
      type: "manual",
    });
    await client.execute(
      "UPDATE assets SET instrument = 'coin_collection', valuation_method = 'stored' WHERE id = 'coleccion'",
    );

    const doc = await store.workspace.exportWorkspace();
    const exported = doc.assets.find((a) => a.id === "coleccion")!;

    expect(exported.instrument).toBe("coin_collection");
    expect(exported.valuationMethod).toBe("derived");
  });

  test("a round-trip cures the incoherence instead of fixing it", async () => {
    await freshStore();
    await store.workspace.importWorkspace(makeContradictoryDocument());

    const doc = await store.workspace.exportWorkspace();
    await store.workspace.importWorkspace(doc);

    expect(await storedMethodOf("doc-coleccion")).toBe("derived");
  });
});
