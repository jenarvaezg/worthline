/**
 * A connected holding's instrument is its ADAPTER's (#1691).
 *
 * The v14 backfill derived `assets.instrument` from the legacy `AssetType` with a
 * blind `ELSE 'other'` (`migrate.ts`), and a connected source materializes its
 * holding as `type = 'manual'` — so every collection connected before v14 came out
 * of that migration labelled `other`. The value stayed right (the sync matches the
 * row by source + rung, never by instrument), which is exactly why it went
 * unnoticed: nothing on the surface disagreed with the money.
 *
 * These pin the two halves of the fix: the sync heals the label, and the
 * balance-reconciliation door refuses a source-owned holding without leaning on
 * the instrument column being right.
 */

import { openLibsqlClient } from "@db/index";
import { createStoreFromSqlite, type PersistenceTestStore } from "@db/testing";
import type { Client } from "@libsql/client";
import type { CoinPosition } from "@worthline/domain";
import { afterEach, describe, expect, test } from "vitest";

const MEMBER_ID = "m1";

let client: Client;
let store: PersistenceTestStore;

afterEach(() => {
  store?.close();
});

/** One coin to sync, so the re-roll has a rung to write. */
function coin(): Omit<CoinPosition, "id" | "sourceId"> {
  return {
    catalogueId: "n123",
    currency: "EUR",
    externalId: "n123",
    finenessMillis: null,
    grade: "VF",
    issueId: null,
    kind: "coin",
    liquidityTier: "illiquid",
    metal: "silver",
    metalValueMinor: null,
    name: "8 reales",
    numismaticFetchedAt: null,
    numismaticValueMinor: null,
    obverseThumbUrl: null,
    purchaseDate: "2024-01-01",
    purchasePriceMinor: 5_000,
    quantity: 1,
    weightGrams: null,
    year: null,
  };
}

/** A workspace with a live Numista collection, and the raw client beside it. */
async function connectedCollection(): Promise<{ assetId: string; sourceId: string }> {
  client = openLibsqlClient(":memory:");
  store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  return store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: "secret" }),
    label: "Colección Numista",
    ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
  });
}

const instrumentOf = async (assetId: string): Promise<string | null> =>
  (
    (
      await client.execute({
        args: [assetId],
        sql: "SELECT instrument AS i FROM assets WHERE id = ?",
      })
    ).rows[0] as unknown as { i: string | null }
  ).i;

/** Put the row back in the shape the v14 backfill left it in. */
async function relabelAsPreV14(assetId: string): Promise<void> {
  await client.execute({
    args: [assetId],
    sql: "UPDATE assets SET instrument = 'other' WHERE id = ?",
  });
}

describe("the sync re-asserts the instrument", () => {
  test("a collection mislabelled `other` is healed by the next sync", async () => {
    const { assetId, sourceId } = await connectedCollection();
    await store.connectedSources.syncPositions(
      sourceId,
      [coin()],
      "2026-01-01T00:00:00.000Z",
    );
    await relabelAsPreV14(assetId);
    expect(await instrumentOf(assetId)).toBe("other");

    await store.connectedSources.syncPositions(
      sourceId,
      [coin()],
      "2026-02-01T00:00:00.000Z",
    );

    expect(await instrumentOf(assetId)).toBe("coin_collection");
  });
});

describe("balance reconciliation refuses a source-owned destination", () => {
  test("rejects it even when the instrument column says it is hand-valued", async () => {
    const { assetId } = await connectedCollection();
    // The whole point: with `other` the derivation answers `stored`, so the door
    // would open on the strength of a column the backfill got wrong.
    await relabelAsPreV14(assetId);

    const contribution = await store.contributionPlan.createPlannedContribution({
      amount: { mode: "money", value: 100_00 },
      cadence: { dayOfMonth: 1, kind: "monthly" },
      destinationHoldingId: assetId,
      scopeId: "default",
      startDate: "2026-01-01",
    });

    await expect(
      store.command.applyStoredContributionValue({
        assetId,
        contributionId: contribution.id,
        executedMinor: 100_00,
        newValueMinor: 60_000,
        occurrenceId: `${contribution.id}:2026-01-01`,
      }),
    ).rejects.toThrow(/Only stored-value destinations/);
  });
});
