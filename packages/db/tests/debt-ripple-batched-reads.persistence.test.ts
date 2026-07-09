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
 *      instrument the libSQL client by wrapping `execute`/`batch` and count the
 *      reads.
 */

import type { WorthlineStore } from "@db/index";
import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-12";

/** A YYYY-MM-DD `count` days after `from`. */
function addDays(from: string, count: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

/** Pull the SQL text out of any libSQL statement shape (string, `{ sql }`, or
 *  the `[sql, args?]` batch tuple). */
function sqlText(stmt: unknown): string {
  if (typeof stmt === "string") return stmt;
  if (Array.isArray(stmt) && typeof stmt[0] === "string") return stmt[0];
  if (
    stmt &&
    typeof stmt === "object" &&
    typeof (stmt as { sql?: unknown }).sql === "string"
  ) {
    return (stmt as { sql: string }).sql;
  }
  return "";
}

/**
 * Wrap a libSQL client so every SQL statement it runs is reported to `tally`.
 *
 * The libSQL client has no `verbose` hook, so we wrap `execute`/`batch` (drizzle
 * routes every read through `execute`) and inspect each SQL string.
 */
function instrumentClient(real: Client, tally: (sql: string) => void): Client {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (...args: unknown[]) => {
          tally(sqlText(args[0]));
          return (target.execute as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (prop === "batch") {
        return (...args: unknown[]) => {
          const [stmts] = args;
          if (Array.isArray(stmts)) for (const s of stmts) tally(sqlText(s));
          return (target.batch as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
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
 * Seed a long DAILY band of pre-existing snapshots via a priced `seedfund`
 * investment whose daily backdated buys each generate that day's snapshot
 * (ADR 0012). Then seed a `mortgage` with an amortizable plan whose disbursement
 * is at the band start, so a debt ripple recalculates the WHOLE band per scope.
 */
async function seedBandWithMortgage(store: WorthlineStore): Promise<{
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

  // A daily band of pre-existing snapshots: one backdated buy of `seedfund` per
  // day, each generating that day's snapshot.
  for (let i = 0; i < BAND_SNAPSHOTS; i += 1) {
    const dateKey = addDays(BAND_START, i);
    await store.recordOperationAndRipple(
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
  await store.liabilities.createLiability({
    balanceMinor: 100_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");

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

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots("household")).find(
    (snap) => snap.dateKey === dateKey,
  )?.debts.amountMinor;
}

async function grossAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots("household")).find(
    (snap) => snap.dateKey === dateKey,
  )?.grossAssets.amountMinor;
}

describe("debt ripple batches frozen reads (#206)", () => {
  test("reads frozen holdings in a bounded shape, not one query per recalculated snapshot", async () => {
    const { store, holdingReads, reset } = await createCountingStore();
    const { snapshotCount } = await seedBandWithMortgage(store);

    // Confirm the band really is large — otherwise the read-shape assertion is
    // vacuous and a regression would hide.
    const household = await store.snapshots.readSnapshots("household");
    expect(household.length).toBe(snapshotCount);
    const scopeCount = (await store.snapshots.readSnapshots()).reduce(
      (acc, snap) => acc.add(snap.scopeId),
      new Set<string>(),
    ).size;

    // An amortizable plan disbursed at the band start ripples the WHOLE band per
    // scope (recalc from the disbursement date forward, ADR 0019). The plan
    // persist runs no `snapshot_holdings` SELECT, so resetting just before the
    // seam call still counts only the ripple's reads.
    reset();
    await store.createAmortizationPlanAndRipple(PLAN_INPUT, { today: TODAY });

    // BATCHED: the frozen-row reads are a small constant per scope/range, never
    // ~one per recalculated snapshot. With ~40 snapshots per scope, the old
    // shape was ~40 reads/scope; the batched shape is a handful per scope.
    const reads = holdingReads();
    expect(reads).toBeLessThanOrEqual(scopeCount * 4);
    expect(reads).toBeLessThan(snapshotCount);

    store.close();
  });

  test("preserves ADR 0012 / ADR 0019 behavior byte-identically across a long band", async () => {
    const { store } = await createCountingStore();
    const { startDate, snapshotCount } = await seedBandWithMortgage(store);
    const lastDate = addDays(startDate, snapshotCount - 1);

    // Pre-ripple: the seed asset gross at each date (i+1 daily 1-unit buys at
    // 100.00 each) and no debts yet.
    const seedGrossAt = (i: number): number => (i + 1) * 100_00;
    for (let i = 0; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      expect(await grossAt(store, dateKey)).toBe(seedGrossAt(i));
    }

    await store.createAmortizationPlanAndRipple(PLAN_INPUT, { today: TODAY });

    // Behavior check across the WHOLE band: every snapshot ≥ disbursement now
    // values the mortgage at its curve balance, and every seed asset row is
    // preserved untouched (only the liability row is recomputed, ADR 0012).
    for (let i = 0; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      const expectedDebt = await store.liabilities.debtBalanceAtDate("mortgage", dateKey);
      expect(await debtsAt(store, dateKey)).toBe(expectedDebt);
      expect(await grossAt(store, dateKey)).toBe(seedGrossAt(i));
    }
    // The loan-start snapshot equals the initial capital.
    expect(await debtsAt(store, startDate)).toBe(150_000_00);
    expect(await debtsAt(store, lastDate)).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", lastDate),
    );

    store.close();
  });

  test("a mid-band rate revision recalculates only the dates on or after it", async () => {
    const { store } = await createCountingStore();
    const { startDate, snapshotCount } = await seedBandWithMortgage(store);
    await store.createAmortizationPlanAndRipple(PLAN_INPUT, { today: TODAY });

    const revisionDate = addDays(startDate, 20);
    const beforeRevision: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      beforeRevision.push((await debtsAt(store, addDays(startDate, i)))!);
    }

    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;
    await store.addInterestRateRevisionAndRipple(
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
      expect(await debtsAt(store, addDays(startDate, i))).toBe(beforeRevision[i]);
    }
    for (let i = 20; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }

    store.close();
  });
});
