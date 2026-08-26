/**
 * The band builds whole-portfolio deps only when a date needs building (#1590).
 *
 * `buildHistoricalSnapshotDeps` is a full read of the workspace — every asset,
 * liability, operation, curve, coin position, price and manual-value point. The
 * band needs it to MINT a snapshot at a past event date, and for nothing else.
 * The commonest write in the app mints nothing: an operation recorded with
 * today's date is covered by the daily capture (ADR 0012), so no `histsnap_` is
 * built and the deps read must never happen.
 *
 * Before the band existed, the single-operation ripple got this right by
 * building deps lazily inside its generate branch; folding it into the batched
 * ripple would have made every "buy, today" pay for a read it discards. The band
 * takes deps as a thunk for exactly this reason, so this test pins the bound:
 *
 *   - an operation dated TODAY → zero deps reads;
 *   - the same operation BACKDATED → the deps read happens (once).
 */

import type { WorthlineStore } from "@db/index";
import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import { describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

const TODAY = "2026-06-12";
const BACKDATED = "2024-03-01";

/**
 * A store on an instrumented client counting the manual-value-history SELECT of
 * `audit_log`. Nothing else on the record-an-operation path reads that table, and
 * `buildHistoricalSnapshotDeps` always does (once, for every asset and liability
 * id at once), so it is a faithful marker for "deps were built".
 */
async function createCountingStore(): Promise<{
  store: WorthlineStore;
  depsReads: () => number;
  reset: () => void;
}> {
  let count = 0;
  const tally = (text: string): void => {
    if (/\baudit_log\b/i.test(text) && /^\s*select/i.test(text)) count += 1;
  };
  const real = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(instrumentClient(real, tally));
  return {
    depsReads: () => count,
    reset: () => {
      count = 0;
    },
    store,
  };
}

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
  });
}

async function buy(store: WorthlineStore, executedAt: string): Promise<void> {
  await store.command.recordInvestmentOperation(
    {
      assetId: "fund",
      currency: "EUR",
      executedAt,
      feesMinor: 0,
      id: `op_${executedAt}`,
      kind: "buy",
      pricePerUnit: "10.00",
      units: "100",
    },
    { today: TODAY },
  );
}

describe("ripple band — deps are read only to mint a snapshot (#1590)", () => {
  test("an operation dated today builds no whole-portfolio deps", async () => {
    const { store, depsReads, reset } = await createCountingStore();
    await seed(store);

    reset();
    await buy(store, TODAY);

    expect(depsReads()).toBe(0);
    store.close();
  });

  test("a backdated operation does build them, and once", async () => {
    const { store, depsReads, reset } = await createCountingStore();
    await seed(store);

    reset();
    await buy(store, BACKDATED);

    // Built once for the whole band, not once per scope (lesson from #114).
    expect(depsReads()).toBe(1);
    // And it did what it was read for: the past date now carries a snapshot.
    expect(
      (await store.snapshots.readSnapshots()).some((snap) => snap.dateKey === BACKDATED),
    ).toBe(true);
    store.close();
  });
});
