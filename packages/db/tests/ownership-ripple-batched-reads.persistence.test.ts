/**
 * Ownership-ripple frozen-read batching (issue #1533, ADR 0012 / ADR 0020).
 *
 * The historical-snapshot ripple after an ownership-split edit must keep its
 * ADR 0012 / ADR 0020 behavior byte-identical, while reading the affected frozen
 * holding rows in a BATCHED shape per scope instead of one query per snapshot
 * (and per nested household lookup). Operation (#205) and debt (#206) ripples
 * already pin this bound; ownership was the remaining gap alongside valuation.
 *
 * These tests pin two things at once:
 *   1. BEHAVIOR — correcting a split across a long band of pre-existing
 *      snapshots re-weights every per-member date to the new split, leaves the
 *      household total unchanged, and creates no new snapshot dates.
 *   2. READ SHAPE — the number of SELECT statements that touch
 *      `snapshot_holdings` during the ripple is BOUNDED per scope (a small
 *      constant), not proportional to the number of re-weighted snapshots.
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

/**
 * Build a store on an instrumented in-memory client that counts every SQL
 * statement reading `snapshot_holdings`, so a test can assert the ripple's read
 * shape. The counter starts at 0 and the caller resets it before the action.
 *
 * We count only SELECTs of the frozen rows, never the deletes/inserts the save
 * path runs — the issue is about the READ fan-out per snapshot.
 */
async function createCountingStore(): Promise<{
  store: WorthlineStore;
  holdingReads: () => number;
  reset: () => void;
}> {
  let count = 0;
  const tally = (text: string): void => {
    if (/\bsnapshot_holdings\b/i.test(text) && /^\s*select/i.test(text)) count += 1;
  };
  const real = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(instrumentClient(real, tally));
  return {
    holdingReads: () => count,
    reset: () => {
      count = 0;
    },
    store,
  };
}

const BAND_START = "2024-01-01";
const BAND_SNAPSHOTS = 40;

/**
 * Seed a 2-member household and a long DAILY band of pre-existing snapshots via
 * a priced `seedFund` whose daily backdated buys each generate that day's
 * snapshot (ADR 0012). The fund starts 50/50 so an ownership edit re-weights
 * every date in the band.
 */
async function seedBandWithSplitFund(store: WorthlineStore): Promise<{
  startDate: string;
  snapshotCount: number;
}> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "seedFund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo semilla",
    ownership: [
      { memberId: "mJ", shareBps: 5_000 },
      { memberId: "mA", shareBps: 5_000 },
    ],
  });

  for (let i = 0; i < BAND_SNAPSHOTS; i += 1) {
    const dateKey = addDays(BAND_START, i);
    await store.command.recordInvestmentOperation(
      {
        assetId: "seedFund",
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

  return { snapshotCount: BAND_SNAPSHOTS, startDate: BAND_START };
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  )?.grossAssets.amountMinor;
}

describe("ownership ripple batches frozen reads (#1533)", () => {
  test("reads frozen holdings in a bounded shape, not one query per re-weighted snapshot", async () => {
    const { store, holdingReads, reset } = await createCountingStore();
    const { snapshotCount } = await seedBandWithSplitFund(store);

    const household = await store.snapshots.readSnapshots("household");
    expect(household.length).toBe(snapshotCount);
    const scopeCount = (await store.snapshots.readSnapshots()).reduce(
      (acc, snap) => acc.add(snap.scopeId),
      new Set<string>(),
    ).size;

    // A 50/50 → 70/30 split edit re-weights the WHOLE band per scope. The persist
    // runs no `snapshot_holdings` SELECT, so resetting just before the seam call
    // still counts only the ripple's reads.
    reset();
    await store.command.updateAssetOwnership(
      "seedFund",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
      { today: TODAY },
    );

    const reads = holdingReads();
    expect(reads).toBeLessThanOrEqual(scopeCount * 4);
    expect(reads).toBeLessThan(snapshotCount);

    store.close();
  });

  test("re-weights every per-member snapshot to the new split; household unchanged", async () => {
    const { store } = await createCountingStore();
    const { startDate, snapshotCount } = await seedBandWithSplitFund(store);

    const datesBefore = (await store.snapshots.readSnapshots("mJ")).length;

    await store.command.updateAssetOwnership(
      "seedFund",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
      { today: TODAY },
    );

    for (let i = 0; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      const global = (i + 1) * 100_00;
      expect(await grossAt(store, dateKey, "household")).toBe(global);
      expect(await grossAt(store, dateKey, "mJ")).toBe(
        Math.round((global * 7_000) / 10_000),
      );
      expect(await grossAt(store, dateKey, "mA")).toBe(
        Math.round((global * 3_000) / 10_000),
      );
    }

    expect((await store.snapshots.readSnapshots("mJ")).length).toBe(datesBefore);

    store.close();
  });
});
