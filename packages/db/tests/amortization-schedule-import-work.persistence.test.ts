/**
 * The WORK a cuadro-de-amortización import actually does (#1440).
 *
 * #1435 batched the re-baseline chain. The amortization-schedule reader still
 * wrote one revision and one repayment per round-trip — plus another trip for
 * each audit row. A real bank schedule is dozens of events; against a remote
 * Turso that is 2·(N+M) waits inside the one transaction.
 *
 * These tests pin the WRITE shape of `importAmortizationSchedule`: the N
 * revisions and M repayments go in as batched inserts, not N+M sequential
 * round-trips. The trail still gets one audit row per fact.
 */

import type { WorthlineStore } from "@db/index";
import { createStoreFromSqlite, openLibsqlClient } from "@db/index";
import { describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

const TODAY = "2026-07-02";
const REVISION_COUNT = 24;
const REPAYMENT_COUNT = 12;

function addMonthsTo(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  date.setUTCDate(Math.min(d, lastDay.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

async function createCountingStore(): Promise<{
  store: WorthlineStore;
  revisionInserts: () => number;
  repaymentInserts: () => number;
  auditInserts: () => number;
  reset: () => void;
}> {
  let revisions = 0;
  let repayments = 0;
  let audits = 0;
  const tally = (text: string): void => {
    if (!/^\s*insert/i.test(text)) return;
    if (/\binterest_rate_revisions\b/i.test(text)) revisions += 1;
    if (/\bearly_repayments\b/i.test(text)) repayments += 1;
    if (/\baudit_log\b/i.test(text)) audits += 1;
  };
  const store = await createStoreFromSqlite(
    instrumentClient(openLibsqlClient(":memory:"), tally),
  );
  return {
    auditInserts: () => audits,
    repaymentInserts: () => repayments,
    reset: () => {
      audits = 0;
      repayments = 0;
      revisions = 0;
    },
    revisionInserts: () => revisions,
    store,
  };
}

async function seedMortgage(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
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
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
    { today: TODAY },
  );
}

function revisions() {
  return Array.from({ length: REVISION_COUNT }, (_, i) => ({
    id: `rev_${i}`,
    newAnnualInterestRate: i % 2 === 0 ? "0.03" : "0.035",
    planId: "plan1",
    revisionDate: addMonthsTo("2026-02-15", i),
  }));
}

function repayments() {
  return Array.from({ length: REPAYMENT_COUNT }, (_, i) => ({
    amountMinor: 1_000_00,
    id: `lump_${i}`,
    mode: "reduce-payment" as const,
    planId: "plan1",
    repaymentDate: addMonthsTo("2026-03-01", i),
  }));
}

describe("amortization-schedule import work shape (#1440)", () => {
  test("persists the whole cuadro in batched inserts, one audit row per fact", async () => {
    const { store, revisionInserts, repaymentInserts, auditInserts, reset } =
      await createCountingStore();
    await seedMortgage(store);

    reset();
    const written = await store.command.importAmortizationSchedule({
      earlyRepayments: repayments(),
      liabilityId: "mortgage",
      revisions: revisions(),
      today: TODAY,
    });

    expect(written).toBe(REVISION_COUNT + REPAYMENT_COUNT);
    // ONE statement per table, not one round-trip per event (the batch fits in
    // a single insert at this length).
    expect(revisionInserts()).toBe(1);
    expect(repaymentInserts()).toBe(1);
    // One batched audit statement per fact type, not one trip per event.
    expect(auditInserts()).toBe(2);
    expect(await store.liabilities.readInterestRateRevisions("plan1")).toHaveLength(
      REVISION_COUNT,
    );
    expect(await store.liabilities.readEarlyRepayments("plan1")).toHaveLength(
      REPAYMENT_COUNT,
    );
    const audit = await store.readAuditLog({ entityId: "plan1" });
    expect(audit.filter((entry) => entry.action === "add_rate_revision")).toHaveLength(
      REVISION_COUNT,
    );
    expect(audit.filter((entry) => entry.action === "add_early_repayment")).toHaveLength(
      REPAYMENT_COUNT,
    );

    store.close();
  });
});
