/**
 * ImportBalanceHistory command (#969): first vertical tracer over
 * ApplyDatedFactsBatch — in-memory, no server actions.
 */

import type { WorthlineStore } from "@worthline/db";
import {
  createInMemoryStore,
  createStoreFromSqlite,
  openLibsqlClient,
} from "@worthline/db";
import { describe, expect, test } from "vitest";

import { executeImportBalanceHistoryCommand, runCommand } from "./index";

const TODAY = "2026-07-02";

async function snapAt(store: WorthlineStore, dateKey: string) {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey);
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await snapAt(store, dateKey))?.debts.amountMinor;
}

async function seedAmortizableMortgage(store?: WorthlineStore): Promise<WorthlineStore> {
  const activeStore = store ?? (await createInMemoryStore());
  await activeStore.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await activeStore.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await activeStore.liabilities.setDebtModel("mortgage", "amortizable");
  await activeStore.command.createAmortizationPlan(
    {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
    { today: TODAY },
  );
  return activeStore;
}

describe("executeImportBalanceHistoryCommand (#969)", () => {
  test("persists exactly one fact batch and links every inserted fact to it", async () => {
    const client = openLibsqlClient(":memory:");
    const store = await seedAmortizableMortgage(await createStoreFromSqlite(client));

    const result = await executeImportBalanceHistoryCommand(store, {
      liabilityId: "mortgage",
      rebaselines: [
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-04-15",
          endDate: "2046-01-15",
          id: "reb1",
          liabilityId: "mortgage",
          nextPaymentDate: "2026-05-15",
          outstandingBalanceMinor: 145_000_00,
        },
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-06-15",
          endDate: "2046-01-15",
          id: "reb2",
          liabilityId: "mortgage",
          nextPaymentDate: "2026-07-15",
          outstandingBalanceMinor: 140_000_00,
        },
      ],
      today: TODAY,
    });

    expect(result.ok).toBe(true);
    const batches = await client.execute("SELECT id, trigger FROM fact_batch");
    expect(batches.rows).toHaveLength(1);
    expect(batches.rows[0]!.trigger).toBe("manual");
    const facts = await client.execute(
      "SELECT DISTINCT batch_id FROM liability_balance_rebaselines ORDER BY batch_id",
    );
    expect(facts.rows).toEqual([{ batch_id: batches.rows[0]!.id }]);

    store.close();
  });

  test("creates a chain of re-baselines with ONE ripple from the oldest checkpoint", async () => {
    const store = await seedAmortizableMortgage();
    const beforeOldest = await debtsAt(store, "2026-03-15");
    expect(beforeOldest).toBeDefined();

    const result = await runCommand(
      executeImportBalanceHistoryCommand,
      {
        liabilityId: "mortgage",
        rebaselines: [
          {
            annualInterestRate: "0.03",
            baselineDate: "2026-04-15",
            endDate: "2046-01-15",
            id: "reb1",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-05-15",
            outstandingBalanceMinor: 145_000_00,
            startsAtBaseline: false,
          },
          {
            annualInterestRate: "0.03",
            baselineDate: "2026-06-15",
            endDate: "2046-01-15",
            id: "reb2",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-07-15",
            outstandingBalanceMinor: 140_000_00,
            startsAtBaseline: false,
          },
        ],
        today: TODAY,
      },
      store,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        created: 2,
        ripple: { fromDateKey: "2026-04-15", today: TODAY },
      },
    });

    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(2);
    expect(rebaselines.every((r) => r.startsAtBaseline === false)).toBe(true);

    expect(await debtsAt(store, "2026-03-15")).toBe(beforeOldest);
    expect(await debtsAt(store, "2026-04-15")).toBe(145_000_00);
    expect(await debtsAt(store, "2026-06-15")).toBe(140_000_00);

    store.close();
  });

  test("audit-trails each created re-baseline", async () => {
    const store = await seedAmortizableMortgage();

    const result = await runCommand(
      executeImportBalanceHistoryCommand,
      {
        liabilityId: "mortgage",
        rebaselines: [
          {
            annualInterestRate: "0.03",
            baselineDate: "2026-04-15",
            endDate: "2046-01-15",
            id: "reb1",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-05-15",
            outstandingBalanceMinor: 145_000_00,
            startsAtBaseline: false,
          },
          {
            annualInterestRate: "0.03",
            baselineDate: "2026-06-15",
            endDate: "2046-01-15",
            id: "reb2",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-07-15",
            outstandingBalanceMinor: 140_000_00,
            startsAtBaseline: false,
          },
        ],
        today: TODAY,
      },
      store,
    );

    expect(result.ok).toBe(true);

    const audit = await store.readAuditLog({ entityId: "mortgage" });
    expect(
      audit.filter((entry) => entry.action === "add_balance_rebaseline"),
    ).toHaveLength(2);

    store.close();
  });

  test("returns created=0 and ripples nothing for an empty batch", async () => {
    const store = await seedAmortizableMortgage();
    const before = await debtsAt(store, "2026-03-15");

    const result = await runCommand(
      executeImportBalanceHistoryCommand,
      {
        liabilityId: "mortgage",
        rebaselines: [],
        today: TODAY,
      },
      store,
    );

    expect(result).toEqual({
      ok: true,
      value: { created: 0, ripple: null },
    });
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);
    expect(await debtsAt(store, "2026-03-15")).toBe(before);

    store.close();
  });

  test("rolls back the whole batch when a mid-insert fails", async () => {
    const store = await seedAmortizableMortgage();

    const result = await runCommand(
      executeImportBalanceHistoryCommand,
      {
        liabilityId: "mortgage",
        rebaselines: [
          {
            annualInterestRate: "0.03",
            baselineDate: "2026-04-15",
            endDate: "2046-01-15",
            id: "reb_ok",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-05-15",
            outstandingBalanceMinor: 145_000_00,
            startsAtBaseline: false,
          },
          {
            baselineDate: "2026-06-15",
            endDate: "2046-01-15",
            id: "reb_bad",
            liabilityId: "mortgage",
            nextPaymentDate: "2026-07-15",
            outstandingBalanceMinor: 140_000_00,
            startsAtBaseline: false,
          },
        ],
        today: TODAY,
      },
      store,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });
});
