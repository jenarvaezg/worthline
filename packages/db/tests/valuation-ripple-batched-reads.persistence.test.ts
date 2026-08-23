/**
 * Valuation-ripple frozen-read batching (issue #1533, ADR 0012).
 *
 * The historical-snapshot ripple after a housing valuation — a market appraisal
 * anchor — must keep its ADR 0012 behavior byte-identical, while reading the
 * affected frozen holding rows in a BATCHED shape per scope/range instead of
 * one query per recalculated snapshot. Operation (#205) and debt (#206) ripples
 * already pin this bound; valuation was the remaining gap.
 *
 * These tests pin two things at once:
 *   1. BEHAVIOR — a backdated appraisal across a long band of pre-existing
 *      snapshots folds the housing asset to the curve value on every date, and
 *      every other frozen row is preserved.
 *   2. READ SHAPE — the number of SELECT statements that touch
 *      `snapshot_holdings` during the ripple is BOUNDED per scope/range (a small
 *      constant), not proportional to the number of rippled snapshots.
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
const HOME_VALUE = 200_000_00;

/**
 * Seed a long DAILY band of pre-existing snapshots via a priced `seedFund`
 * investment whose daily backdated buys each generate that day's snapshot
 * (ADR 0012). Then seed a housing asset with no appraisal yet, so the valuation
 * seam in the test body ripples the WHOLE band per scope.
 */
async function seedBandWithHome(store: WorthlineStore): Promise<{
  startDate: string;
  snapshotCount: number;
}> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "seedFund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo semilla",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
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

  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: HOME_VALUE,
    id: "home",
    liquidityTier: "illiquid",
    name: "Casa",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "real_estate",
  });

  return { snapshotCount: BAND_SNAPSHOTS, startDate: BAND_START };
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots("household")).find(
    (snap) => snap.dateKey === dateKey,
  )?.grossAssets.amountMinor;
}

describe("valuation ripple batches frozen reads (#1533)", () => {
  test("reads frozen holdings in a bounded shape, not one query per recalculated snapshot", async () => {
    const { store, holdingReads, reset } = await createCountingStore();
    const { snapshotCount } = await seedBandWithHome(store);

    const household = await store.snapshots.readSnapshots("household");
    expect(household.length).toBe(snapshotCount);
    const scopeCount = (await store.snapshots.readSnapshots()).reduce(
      (acc, snap) => acc.add(snap.scopeId),
      new Set<string>(),
    ).size;

    // A backdated appraisal at the band start ripples the WHOLE band per scope.
    // The persist runs no `snapshot_holdings` SELECT, so resetting just before
    // the seam call still counts only the ripple's reads.
    reset();
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "home",
        id: "appraisal1",
        valuationDate: BAND_START,
        valueMinor: HOME_VALUE,
      },
      { today: TODAY },
    );

    const reads = holdingReads();
    expect(reads).toBeLessThanOrEqual(scopeCount * 4);
    expect(reads).toBeLessThan(snapshotCount);

    store.close();
  });

  test("preserves ADR 0012 behavior byte-identically across a long band", async () => {
    const { store } = await createCountingStore();
    const { startDate, snapshotCount } = await seedBandWithHome(store);

    const seedGrossAt = (i: number): number => (i + 1) * 100_00;
    for (let i = 0; i < snapshotCount; i += 1) {
      expect(await grossAt(store, addDays(startDate, i))).toBe(seedGrossAt(i));
    }

    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "home",
        id: "appraisal1",
        valuationDate: BAND_START,
        valueMinor: HOME_VALUE,
      },
      { today: TODAY },
    );

    for (let i = 0; i < snapshotCount; i += 1) {
      expect(await grossAt(store, addDays(startDate, i))).toBe(
        seedGrossAt(i) + HOME_VALUE,
      );
    }

    store.close();
  });
});
