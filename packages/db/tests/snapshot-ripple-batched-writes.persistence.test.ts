/**
 * Snapshot-ripple write batching (issue #1532).
 *
 * Saving a backdated mutation rewrites every affected snapshot with several
 * SQL statements each. Against Turso those statements are independent HTTP
 * POSTs, so a long history freezes on "Guardando…". This suite pins:
 *
 *   1. BEHAVIOR — a backdated operation across a long pre-existing band still
 *      folds the operated investment into every date (ADR 0012).
 *   2. WRITE SHAPE — round-trips (`execute` + `batch` *calls*) during the
 *      mutation are BOUNDED, not proportional to the number of snapshots.
 *      Statements inside a batch may still grow with history; the trips must
 *      not. Instrumented via `instrument-libsql-client`.
 *
 * libSQL `:memory:` interactive transactions open a second connection that
 * cannot see the in-memory db (store-context therefore hand-rolls BEGIN).
 * `client.batch()` on the file protocol also starts its own BEGIN, so the
 * production path uses `Transaction.batch` remotely and same-connection
 * executes locally — the bound still holds because chunked writes collapse
 * N snapshots into a handful of statements.
 */

import type { WorthlineStore } from "@db/index";
import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import { describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

const TODAY = "2026-06-12";

/** A YYYY-MM-DD `count` days after `from`. */
function addDays(from: string, count: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

async function createCountingStore(): Promise<{
  store: WorthlineStore;
  roundTrips: () => number;
  reset: () => void;
}> {
  let trips = 0;
  const client = instrumentClient(
    openLibsqlClient(":memory:"),
    () => {
      /* statement bodies are allowed to grow with history */
    },
    () => {
      trips += 1;
    },
  );
  const store = await createStoreFromSqlite(client);
  return {
    reset: () => {
      trips = 0;
    },
    roundTrips: () => trips,
    store,
  };
}

async function seedManySnapshots(store: WorthlineStore): Promise<{
  startDate: string;
  snapshotCount: number;
}> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "seedfund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo semilla",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });

  const startDate = "2024-01-01";
  const snapshotCount = 40;
  for (let i = 0; i < snapshotCount; i += 1) {
    const dateKey = addDays(startDate, i);
    await store.command.recordInvestmentOperation(
      {
        assetId: "seedfund",
        currency: "EUR",
        executedAt: dateKey,
        id: `seedop_${dateKey}`,
        kind: "buy",
        pricePerUnit: "100",
        units: "1",
      },
      { today: TODAY },
    );
  }

  return { snapshotCount, startDate };
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots("household")).find(
    (snap) => snap.dateKey === dateKey,
  )?.grossAssets.amountMinor;
}

describe("snapshot ripple batches writes (#1532)", () => {
  test("a backdated mutation's round-trips stay bounded, not one trip per snapshot", async () => {
    const { store, roundTrips, reset } = await createCountingStore();
    const { startDate, snapshotCount } = await seedManySnapshots(store);

    const household = await store.snapshots.readSnapshots("household");
    expect(household.length).toBe(snapshotCount);

    reset();
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: startDate,
        id: "op_backdated",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const trips = roundTrips();
    // O(tens): the unbatched save rewrote each snapshot with ~6 statements
    // (~240 trips on this 40-snapshot band). Chunked/batched writes must not
    // grow linearly with the band.
    expect(trips).toBeLessThanOrEqual(80);
    expect(trips).toBeLessThan(snapshotCount * 4);

    store.close();
  });

  test("still folds the backdated operation into every snapshot in the band", async () => {
    const { store } = await createCountingStore();
    const { startDate, snapshotCount } = await seedManySnapshots(store);

    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: startDate,
        id: "op_backdated",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const seedAt = (i: number): number => (i + 1) * 100_00;
    const fundValue = 10 * 100_00;
    for (let i = 0; i < snapshotCount; i += 1) {
      expect(await grossAt(store, addDays(startDate, i))).toBe(seedAt(i) + fundValue);
    }

    store.close();
  });
});
