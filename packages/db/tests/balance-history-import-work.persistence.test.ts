/**
 * The WORK a balance-history import actually does (#1435).
 *
 * Confirming a long reconstruction — Jorge's mortgage: 42 monthly checkpoints
 * rebuilt from a bank statement — left the button on "Guardando…" for a long
 * time. Not the network, not the model: the ripple.
 *
 * Every re-baseline's forward schedule runs to the contract end, so in a long
 * chain their date sets overlap almost entirely. The old `flatMap` emitted every
 * checkpoint's whole schedule with no dedup (5.679 dates for the 266 that
 * exist), and the short-circuit that skips a date that already has a snapshot
 * was built BEFORE the loop and never updated inside it — so the second time a
 * date came round the whole 69-asset portfolio was rebuilt and rewritten again.
 *
 * These tests pin the WRITE shape of the import seam, in the two places the
 * issue measured:
 *   1. SNAPSHOT WRITES — bounded by the snapshots that exist (one build per
 *      distinct date + one recalculation), not by the emitted-dates fan-out.
 *   2. FACT WRITES — the N re-baselines go in as a batched insert, not N
 *      sequential round-trips.
 * Plus the behavior itself: every generated date carries the curve balance.
 */

import type { WorthlineStore } from "@db/index";
import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import {
  amortizationPaymentDatesUpTo,
  amortizationPlanFromBalanceRebaseline,
  rebaselineChainPaymentDatesUpTo,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

const TODAY = "2026-08-18";

/** The plan's own boundaries land on the 15th... */
const PLAN_DAY = "15";
/** ...and the checkpoints on the 1st, so their dates have NO snapshot yet and
 *  the generation branch is the one under measurement. */
const CHECKPOINT_COUNT = 24;

function addMonthsTo(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  date.setUTCDate(Math.min(d, lastDay.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

/** The monthly checkpoint chain the import applies — each one modelled to 2044. */
function checkpointChain(): {
  annualInterestRate: string;
  baselineDate: string;
  endDate: string;
  id: string;
  liabilityId: string;
  nextPaymentDate: string;
  outstandingBalanceMinor: number;
  startsAtBaseline: false;
}[] {
  return Array.from({ length: CHECKPOINT_COUNT }, (_, i) => {
    const baselineDate = addMonthsTo("2024-02-01", i);
    return {
      annualInterestRate: "0.03",
      baselineDate,
      endDate: "2044-01-01",
      id: `reb_${baselineDate}`,
      liabilityId: "mortgage",
      nextPaymentDate: addMonthsTo(baselineDate, 1),
      outstandingBalanceMinor: 140_000_00 - i * 500_00,
      startsAtBaseline: false as const,
    };
  });
}

/**
 * A store on an instrumented in-memory client counting the INSERTs the import
 * runs: whole-portfolio snapshot writes, and re-baseline fact writes.
 */
async function createCountingStore(): Promise<{
  store: WorthlineStore;
  snapshotInserts: () => number;
  rebaselineInserts: () => number;
  reset: () => void;
}> {
  let snapshots = 0;
  let rebaselines = 0;
  const tally = (text: string): void => {
    if (!/^\s*insert/i.test(text)) return;
    if (/\binto\s+"?snapshots"?\b/i.test(text)) snapshots += 1;
    if (/\bliability_balance_rebaselines\b/i.test(text)) rebaselines += 1;
  };
  const real = openLibsqlClient(":memory:");
  const store = await createStoreFromSqlite(instrumentClient(real, tally));
  return {
    rebaselineInserts: () => rebaselines,
    reset: () => {
      snapshots = 0;
      rebaselines = 0;
    },
    snapshotInserts: () => snapshots,
    store,
  };
}

/** A mortgage with a long amortizable plan, plus a priced asset so snapshots
 *  carry frozen rows to preserve. */
async function seedMortgage(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 20_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "cash",
  });
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.command.createAmortizationPlan(
    {
      annualInterestRate: "0.03",
      disbursementDate: `2024-01-${PLAN_DAY}`,
      firstPaymentDate: `2024-02-${PLAN_DAY}`,
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
    { today: TODAY },
  );
}

describe("balance-history import work shape (#1435)", () => {
  test("writes each snapshot a bounded number of times, not once per emitted date", async () => {
    const { store, snapshotInserts, reset } = await createCountingStore();
    await seedMortgage(store);
    const chain = checkpointChain();

    const scopeCount = (await store.snapshots.readSnapshots()).reduce(
      (acc, snap) => acc.add(snap.scopeId),
      new Set<string>(),
    ).size;

    reset();
    await store.command.importBalanceHistory({
      liabilityId: "mortgage",
      rebaselines: chain,
      today: TODAY,
    });

    // The scenario really does overlap heavily — otherwise the write-shape
    // assertion below would be vacuous. Measured, not assumed: the raw fan-out
    // is every checkpoint's own schedule; the distinct dates are what the ripple
    // must actually build.
    const emitted = chain.flatMap((checkpoint) =>
      amortizationPaymentDatesUpTo(
        amortizationPlanFromBalanceRebaseline(checkpoint),
        TODAY,
      ),
    ).length;
    const distinct = rebaselineChainPaymentDatesUpTo(
      chain,
      chain[0]!.baselineDate,
      TODAY,
    ).length;
    expect(emitted).toBeGreaterThan(distinct * 10);

    const household = await store.snapshots.readSnapshots("household");
    expect(household.length).toBeGreaterThan(50);

    // BOUNDED: at most one build per distinct date plus one recalculation per
    // existing snapshot, per scope. The un-deduplicated shape wrote ~5× that.
    const writes = snapshotInserts();
    expect(writes).toBeLessThanOrEqual(scopeCount * household.length * 2);

    store.close();
  });

  test("persists the whole chain of re-baselines in a batched insert", async () => {
    const { store, rebaselineInserts, reset } = await createCountingStore();
    await seedMortgage(store);

    reset();
    await store.command.importBalanceHistory({
      liabilityId: "mortgage",
      rebaselines: checkpointChain(),
      today: TODAY,
    });

    // ONE statement for the whole chain, not one round-trip per checkpoint
    // (the chain fits in a single batched insert at this length).
    expect(rebaselineInserts()).toBe(1);
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(
      CHECKPOINT_COUNT,
    );

    store.close();
  });

  test("still values every checkpoint date at its curve balance", async () => {
    const { store } = await createCountingStore();
    await seedMortgage(store);
    const chain = checkpointChain();

    await store.command.importBalanceHistory({
      liabilityId: "mortgage",
      rebaselines: chain,
      today: TODAY,
    });

    const household = await store.snapshots.readSnapshots("household");
    for (const checkpoint of chain) {
      const snap = household.find((s) => s.dateKey === checkpoint.baselineDate);
      expect(snap?.debts.amountMinor).toBe(checkpoint.outstandingBalanceMinor);
      // The cash row is preserved untouched — only the liability is recomputed.
      expect(snap?.grossAssets.amountMinor).toBe(20_000_00);
    }

    store.close();
  });
});
