/**
 * Operation-ripple frozen-read batching (issue #205, ADR 0012).
 *
 * The historical-snapshot ripple after a backdated investment operation must
 * keep its ADR 0012 behavior byte-identical, while reading the affected frozen
 * holding rows in a BATCHED shape per scope/range instead of one query per
 * snapshot date.
 *
 * These tests pin two things at once:
 *   1. BEHAVIOR — recording and deleting a backdated operation across a long
 *      band of pre-existing snapshots produces the exact same gross-asset values
 *      it always did (the operated investment folded to each date, every other
 *      frozen row preserved).
 *   2. READ SHAPE — the number of SELECT statements that touch `snapshot_holdings`
 *      during the ripple is BOUNDED per scope/range (a small constant), not
 *      proportional to the number of rippled snapshots. We instrument the libSQL
 *      client with a counting proxy and count the reads.
 */

import type { WorthlineStore } from "@db/index";
import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import type { Client, InStatement } from "@libsql/client";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-12";

/** A YYYY-MM-DD `count` days after `from`. */
function addDays(from: string, count: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

/** The SQL text carried by a single libSQL statement. */
function statementSql(stmt: InStatement): string {
  return typeof stmt === "string" ? stmt : stmt.sql;
}

/**
 * Wrap a libSQL client so every statement reading `snapshot_holdings` is counted.
 * `client.execute` runs the store's individual reads (drizzle issues each
 * `db.select()` as one `execute`); `client.batch` runs grouped statements. We
 * inspect the SQL text of each and count only the SELECTs over the frozen rows.
 */
function countingClient(client: Client, bump: (sql: string) => void): Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (...args: Parameters<Client["execute"]>) => {
          const sql = typeof args[0] === "string" ? args[0] : statementSql(args[0]);
          bump(sql);
          return (target.execute as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (prop === "batch") {
        return (...args: Parameters<Client["batch"]>) => {
          for (const stmt of args[0]) {
            bump(Array.isArray(stmt) ? stmt[0] : statementSql(stmt));
          }
          return (target.batch as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Client;
}

/**
 * Build a store on an instrumented in-memory connection that counts every SQL
 * statement reading `snapshot_holdings`, so a test can assert the ripple's read
 * shape. The counter starts at 0 and the caller resets it before the action.
 */
async function createCountingStore(): Promise<{
  store: WorthlineStore;
  holdingReads: () => number;
  reset: () => void;
}> {
  let count = 0;
  const client = countingClient(openLibsqlClient(":memory:"), (message) => {
    if (/\bsnapshot_holdings\b/i.test(message)) {
      // Count only reads of the frozen rows, never the deletes/inserts the
      // save path runs — the issue is about the READ fan-out per snapshot.
      if (/^\s*select/i.test(message)) count += 1;
    }
  });
  const store = await createStoreFromSqlite(client);
  return {
    holdingReads: () => count,
    reset: () => {
      count = 0;
    },
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
  // A `seedfund` investment whose daily backdated buys each GENERATE that day's
  // snapshot (ADR 0012), giving us a long band of pre-existing snapshots. It is
  // priced (manual quote 100) so each generated snapshot is non-empty and stable.
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "seedfund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo semilla",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
  // The `fund` we ripple in the tests — a separate, priced investment so the
  // ripple recomputes ONLY its row and every `seedfund` row is preserved.
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    manualPricePerUnit: "100",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });

  // A daily band of pre-existing snapshots: one backdated buy of `seedfund` per
  // day, each generating that day's snapshot. (The first buy generates its date;
  // each later buy generates its own and ripples `seedfund` into the earlier
  // ones — leaving a clean per-day band before we touch `fund`.)
  const startDate = "2024-01-01";
  const snapshotCount = 40;
  for (let i = 0; i < snapshotCount; i += 1) {
    const dateKey = addDays(startDate, i);
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

describe("operation ripple batches frozen reads (#205)", () => {
  test("reads frozen holdings in a bounded shape, not one query per rippled snapshot", async () => {
    const { store, holdingReads, reset } = await createCountingStore();
    const { startDate, snapshotCount } = await seedManySnapshots(store);

    // Confirm the band really is large — otherwise the read-shape assertion is
    // vacuous and a regression would hide.
    const household = await store.snapshots.readSnapshots("household");
    expect(household.length).toBe(snapshotCount);
    const scopeCount = (await store.snapshots.readSnapshots()).reduce(
      (acc, snap) => acc.add(snap.scopeId),
      new Set<string>(),
    ).size;

    // A backdated buy at the very start ripples the WHOLE band per scope. The
    // record persist runs no `snapshot_holdings` SELECT (a pure INSERT), so
    // resetting just before the seam call still counts only the ripple's reads.
    const operationDateKey = startDate;
    reset();
    await store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: operationDateKey,
        id: "op_backdated",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    // BATCHED: the frozen-row reads are a small constant per scope/range, never
    // ~one per rippled snapshot. With ~40 snapshots per scope, the old shape was
    // ~40 reads/scope; the batched shape is a handful per scope. We bound it
    // generously at a few reads per scope so it can never silently regress to
    // the per-snapshot fan-out.
    const reads = holdingReads();
    expect(reads).toBeLessThanOrEqual(scopeCount * 4);
    expect(reads).toBeLessThan(snapshotCount);

    store.close();
  });

  test("preserves ADR 0012 behavior byte-identically across a long band (record then delete)", async () => {
    const { store } = await createCountingStore();
    const { startDate, snapshotCount } = await seedManySnapshots(store);
    const lastDate = addDays(startDate, snapshotCount - 1);

    // Record a backdated buy at the start: every snapshot ≥ start folds 10 units
    // at the captured price 100 = 1000.00, on top of the 1000.00 cash baseline.
    await store.recordOperationAndRipple(
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

    // Behavior check across the WHOLE band. At day i, `seedfund` has folded i+1
    // daily 1-unit buys = (i+1) × 100.00; `fund` adds its 10 units × 100.00 on
    // every day ≥ its start. Both rows are byte-identically reconstructed.
    const seedAt = (i: number): number => (i + 1) * 100_00;
    const fundValue = 10 * 100_00;
    for (let i = 0; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      expect(await grossAt(store, dateKey)).toBe(seedAt(i) + fundValue);
    }
    expect(await grossAt(store, lastDate)).toBe(seedAt(snapshotCount - 1) + fundValue);

    // Delete the backdated buy: every snapshot ≥ its date recalculates back to
    // seedfund-only, none is left showing the now-deleted operation's value. The
    // delete seam derives the asset id and from-date from the deleted row itself.
    const ops = await store.operations.readOperations("fund");
    const target = ops.find((op) => op.executedAt === startDate)!;
    expect(
      await store.deleteOperationAndRipple({ operationId: target.id, today: TODAY }),
    ).not.toBeNull();

    for (let i = 0; i < snapshotCount; i += 1) {
      const dateKey = addDays(startDate, i);
      expect(await grossAt(store, dateKey)).toBe(seedAt(i));
    }

    store.close();
  });

  test("batch-deletes operations with one bounded ripple", async () => {
    const { store, holdingReads, reset } = await createCountingStore();
    const { startDate, snapshotCount } = await seedManySnapshots(store);

    const creates = Array.from({ length: 10 }, (_, i) => {
      const dateKey = addDays(startDate, i);
      return {
        assetId: "fund",
        currency: "EUR",
        executedAt: dateKey,
        id: `fundop_${dateKey}`,
        kind: "buy" as const,
        pricePerUnit: "100",
        units: "10",
      };
    });
    await store.recordOperationsAndRipple({
      assetId: "fund",
      creates,
      overwrites: [],
      today: TODAY,
    });
    const scopeCount = (await store.snapshots.readSnapshots()).reduce(
      (acc, snap) => acc.add(snap.scopeId),
      new Set<string>(),
    ).size;

    reset();
    const deleted = await store.deleteOperationsAndRipple({
      operationIds: creates.map((op) => op.id),
      today: TODAY,
    });

    expect(deleted).toHaveLength(creates.length);
    expect(await store.operations.readOperations("fund")).toHaveLength(0);
    const reads = holdingReads();
    expect(reads).toBeLessThanOrEqual(scopeCount * 4);
    expect(reads).toBeLessThan(snapshotCount);

    const seedAt = (i: number): number => (i + 1) * 100_00;
    for (let i = 0; i < snapshotCount; i += 1) {
      expect(await grossAt(store, addDays(startDate, i))).toBe(seedAt(i));
    }

    store.close();
  });
});
