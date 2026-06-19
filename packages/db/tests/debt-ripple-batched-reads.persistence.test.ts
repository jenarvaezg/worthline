/**
 * Debt-balance-ripple frozen-read batching (issue #206, ADR 0012 / ADR 0019).
 *
 * The historical-snapshot ripple after a debt-balance change — an amortizable
 * plan, an interest-rate revision, an early repayment, or a revolving/informal
 * balance anchor — must keep its ADR 0012 / ADR 0019 behavior byte-identical,
 * while reading the affected frozen holding rows in a BATCHED shape per
 * scope/range instead of one query per recalculated snapshot.
 *
 * These tests pin two things at once:
 *   1. BEHAVIOR — recalculating a long band of pre-existing snapshots from the
 *      disbursement date forward produces the exact same debt values it always
 *      did (the liability folded to its curve balance on each date, every other
 *      frozen row preserved), and a revision dated mid-band recalculates only
 *      the dates on or after it.
 *   2. READ SHAPE — the number of SELECT statements that touch
 *      `snapshot_holdings` during the ripple is BOUNDED per scope/range (a small
 *      constant), not proportional to the number of rippled snapshots. We
 *      instrument the raw better-sqlite3 connection with `verbose` and count the
 *      reads.
 */
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { createStoreFromSqlite } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-06-12";

/** A YYYY-MM-DD `count` days after `from`. */
function addDays(from: string, count: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a store on an instrumented in-memory connection that counts every SQL
 * statement reading `snapshot_holdings`, so a test can assert the ripple's read
 * shape. The counter starts at 0 and the caller resets it before the action.
 */
function createCountingStore(): {
  store: WorthlineStore;
  holdingReads: () => number;
  reset: () => void;
} {
  let count = 0;
  const sqlite = new Database(":memory:", {
    verbose: (message?: unknown) => {
      if (typeof message === "string" && /\bsnapshot_holdings\b/i.test(message)) {
        // Count only reads of the frozen rows, never the deletes/inserts the
        // save path runs — the issue is about the READ fan-out per snapshot.
        if (/^\s*select/i.test(message)) count += 1;
      }
    },
  });
  const store = createStoreFromSqlite(sqlite);
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
 * Seed a long DAILY band of pre-existing snapshots via a priced `seedfund`
 * investment whose daily backdated buys each generate that day's snapshot
 * (ADR 0012). Then seed a `mortgage` with an amortizable plan whose disbursement
 * is at the band start, so a debt ripple recalculates the WHOLE band per scope.
 */
function seedBandWithMortgage(store: WorthlineStore): {
  startDate: string;
  snapshotCount: number;
} {
  store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "seedfund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo semilla",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });

  // A daily band of pre-existing snapshots: one backdated buy of `seedfund` per
  // day, each generating that day's snapshot.
  for (let i = 0; i < BAND_SNAPSHOTS; i += 1) {
    const dateKey = addDays(BAND_START, i);
    store.recordOperationAndRipple(
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

  // The mortgage we ripple — its amortizable plan is disbursed at the band start
  // so every snapshot in the band is recalculated from the disbursement forward.
  // The plan persist + ripple ride the seam in the test body (after `reset()`),
  // so seed only the liability and its debt model here.
  store.liabilities.createLiability({
    balanceMinor: 100_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  store.liabilities.setDebtModel("mortgage", "amortizable");

  return { snapshotCount: BAND_SNAPSHOTS, startDate: BAND_START };
}

/** The amortizable plan the band tests create + ripple through the debt seam. */
const PLAN_INPUT = {
  annualInterestRate: "0.03",
  id: "plan1",
  initialCapitalMinor: 150_000_00,
  liabilityId: "mortgage",
  disbursementDate: BAND_START,
  firstPaymentDate: addDays(BAND_START, 31),
  termMonths: 240,
} as const;

function debtsAt(store: WorthlineStore, dateKey: string): number | undefined {
  return store.snapshots
    .readSnapshots("household")
    .find((snap) => snap.dateKey === dateKey)?.debts.amountMinor;
}

function grossAt(store: WorthlineStore, dateKey: string): number | undefined {
  return store.snapshots
    .readSnapshots("household")
    .find((snap) => snap.dateKey === dateKey)?.grossAssets.amountMinor;
}

describe("debt ripple batches frozen reads (#206)", () => {
  test("reads frozen holdings in a bounded shape, not one query per recalculated snapshot", () => {
    const { store, holdingReads, reset } = createCountingStore();
    const { snapshotCount } = seedBandWithMortgage(store);

    // Confirm the band really is large — otherwise the read-shape assertion is
    // vacuous and a regression would hide.
    const household = store.snapshots.readSnapshots("household");
    expect(household.length).toBe(snapshotCount);
    const scopeCount = store.snapshots
      .readSnapshots()
      .reduce((acc, snap) => acc.add(snap.scopeId), new Set<string>()).size;

    // An amortizable plan disbursed at the band start ripples the WHOLE band per
    // scope (recalc from the disbursement date forward, ADR 0019). The plan
    // persist runs no `snapshot_holdings` SELECT, so resetting just before the
    // seam call still counts only the ripple's reads.
    reset();
    store.createAmortizationPlanAndRipple(PLAN_INPUT, { today: TODAY });

    // BATCHED: the frozen-row reads are a small constant per scope/range, never
    // ~one per recalculated snapshot. With ~40 snapshots per scope, the old
    // shape was ~40 reads/scope; the batched shape is a handful per scope.
    const reads = holdingReads();
    expect(reads).toBeLessThanOrEqual(scopeCount * 4);
    expect(reads).toBeLessThan(snapshotCount);

    store.close();
  });

  test("preserves ADR 0012 / ADR 0019 behavior byte-identically across a long band", () => {
    const { store } = createCountingStore();
    const { startDate, snapshotCount } = seedBandWithMortgage(store);
    const lastDate = addDays(startDate, snapshotCount - 1);

    // Pre-ripple: the seed asset gross at each date (i+1 daily 1-unit buys at
    // 100.00 each) and no debts yet.
    const seedGrossAt = (i: number): number => (i + 1) * 100_00;
    for (let i = 0; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      expect(grossAt(store, dateKey)).toBe(seedGrossAt(i));
    }

    store.createAmortizationPlanAndRipple(PLAN_INPUT, { today: TODAY });

    // Behavior check across the WHOLE band: every snapshot ≥ disbursement now
    // values the mortgage at its curve balance, and every seed asset row is
    // preserved untouched (only the liability row is recomputed, ADR 0012).
    for (let i = 0; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      const expectedDebt = store.liabilities.debtBalanceAtDate("mortgage", dateKey);
      expect(debtsAt(store, dateKey)).toBe(expectedDebt);
      expect(grossAt(store, dateKey)).toBe(seedGrossAt(i));
    }
    // The loan-start snapshot equals the initial capital.
    expect(debtsAt(store, startDate)).toBe(150_000_00);
    expect(debtsAt(store, lastDate)).toBe(
      store.liabilities.debtBalanceAtDate("mortgage", lastDate),
    );

    store.close();
  });

  test("a mid-band rate revision recalculates only the dates on or after it", () => {
    const { store } = createCountingStore();
    const { startDate, snapshotCount } = seedBandWithMortgage(store);
    store.createAmortizationPlanAndRipple(PLAN_INPUT, { today: TODAY });

    const revisionDate = addDays(startDate, 20);
    const beforeRevision: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      beforeRevision.push(debtsAt(store, addDays(startDate, i))!);
    }

    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;
    store.addInterestRateRevisionAndRipple(
      {
        id: "rev1",
        newAnnualInterestRate: "0.09",
        planId,
        revisionDate,
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    // Dates before the revision are untouched; dates on/after it match the new
    // curve.
    for (let i = 0; i < 20; i += 1) {
      expect(debtsAt(store, addDays(startDate, i))).toBe(beforeRevision[i]);
    }
    for (let i = 20; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      expect(debtsAt(store, dateKey)).toBe(
        store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }

    store.close();
  });
});
