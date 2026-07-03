/**
 * Action-level tests for recalibrateDebtBalanceAction (ADR 0056, PRD #670 S3,
 * #678) — "recalibrar con saldo real" on the advanced edit surface, the drift
 * repair for an EXISTING amortizable debt.
 *
 * Declares a fresh balance re-baseline (the SAME dated-fact kind S1/S2 use,
 * `startsAtBaseline: false` here) and rides `addBalanceRebaselineAndRipple` for
 * the forward-only ripple + audit trail (ADR 0012). These tests assert the
 * resulting schedule at the action boundary — a pre-existing snapshot before the
 * recalibration date is untouched (prior art: debt-historical-snapshots tests
 * pin the store seam itself; this exercises the ACTION path on top of it),
 * demo write-gating, and the audit trail entry.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { fixedClock, type Clock } from "@worthline/domain";

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import { recalibrateDebtBalanceAction } from "./actions";

// Drive demo-ness through the persona cookie the store seam reads (mirrors
// app/demo/write-guard.test.ts's minimal mock).
let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

async function runAction(
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await recalibrateDebtBalanceAction(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

const TODAY = "2026-07-02";
const CLOCK = fixedClock(TODAY);

async function snapAt(store: WorthlineStore, dateKey: string) {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey);
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await snapAt(store, dateKey))?.debts.amountMinor;
}

async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
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
  // A past plan (ADR 0019): disbursed and cuota'd well before TODAY, so it
  // already has past-cuota snapshots to ripple against (prior art: the
  // debt-historical-snapshots seedAmortizable fixture).
  await store.createAmortizationPlanAndRipple(
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
  return store;
}

describe("recalibrateDebtBalanceAction — declares the re-baseline and re-derives the schedule", () => {
  test("persists a startsAtBaseline:false re-baseline carrying the plan's rate forward, audit-trailed", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        currentUrl: "/patrimonio/mortgage/editar",
        id: "mortgage",
        rbBalanceDate: "2026-06-15",
        rbOutstandingBalance: "140.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("debt_recalibrated");

    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(1);
    expect(rebaselines[0]).toMatchObject({
      annualInterestRate: "0.03",
      baselineDate: "2026-06-15",
      nextPaymentDate: "2026-07-15",
      outstandingBalanceMinor: 140_000_00,
      startsAtBaseline: false,
    });

    // The re-derived curve reads the declared balance exactly at its own date.
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2026-06-15")).toBe(
      140_000_00,
    );

    // Audit trail entry present (ADR 0012).
    const audit = await store.readAuditLog({ entityId: "mortgage" });
    expect(audit.map((entry) => entry.action)).toContain("add_balance_rebaseline");

    store.close();
  });

  test("ripples forward only — the pre-recalibration snapshot is untouched, on/after reflects the new balance", async () => {
    const store = await seedAmortizableMortgage();
    const beforeRecalibration = await debtsAt(store, "2026-03-15");
    expect(beforeRecalibration).toBeDefined();

    await runAction(
      form({
        id: "mortgage",
        rbBalanceDate: "2026-06-15",
        rbOutstandingBalance: "140.000,00",
      }),
      store,
      CLOCK,
    );

    // Before the recalibration date: the frozen snapshot is byte-identical.
    expect(await debtsAt(store, "2026-03-15")).toBe(beforeRecalibration);
    // On the recalibration date: the ripple regenerated the snapshot to the
    // declared balance.
    expect(await debtsAt(store, "2026-06-15")).toBe(140_000_00);

    store.close();
  });

  test("rejects a saldo real of 0 without persisting anything", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        id: "mortgage",
        rbBalanceDate: "2026-06-15",
        rbOutstandingBalance: "0",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });

  test("rejects a future balance date without persisting anything", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        id: "mortgage",
        rbBalanceDate: "2026-07-03",
        rbOutstandingBalance: "140.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });

  test("a second (chained) recalibration composes off the FIRST re-baseline, not the original plan (#678 review)", async () => {
    const store = await seedAmortizableMortgage();

    await runAction(
      form({
        id: "mortgage",
        rbBalanceDate: "2026-04-15",
        rbOutstandingBalance: "145.000,00",
      }),
      store,
      CLOCK,
    );
    const afterFirst = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(afterFirst).toHaveLength(1);

    await runAction(
      form({
        id: "mortgage",
        rbBalanceDate: "2026-06-15",
        rbOutstandingBalance: "140.000,00",
      }),
      store,
      CLOCK,
    );

    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(2);
    const second = rebaselines.find((r) => r.baselineDate === "2026-06-15")!;
    expect(second).toMatchObject({
      annualInterestRate: "0.03",
      outstandingBalanceMinor: 140_000_00,
      startsAtBaseline: false,
    });
    // The contractual end date is an invariant across the chain (ADR 0056: rate
    // and term compose forward, they don't reset), so it must survive unchanged
    // through TWO re-baselines.
    expect(second.endDate).toBe(afterFirst[0]!.endDate);

    // The first recalibration's own snapshot is untouched by the second ripple
    // (forward-only, ADR 0012); the second's snapshot reflects its own balance.
    expect(await debtsAt(store, "2026-04-15")).toBe(145_000_00);
    expect(await debtsAt(store, "2026-06-15")).toBe(140_000_00);

    store.close();
  });

  test("recalibrates a current-state (startsAtBaseline) debt with no plan row — an imported debt (#678 review)", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.liabilities.createLiability({
      balanceMinor: 90_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca vieja",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");
    // No plan row at all — only the startsAtBaseline fact governs the curve.
    // The #676 create-time atomicity guarantee (plan + rebaseline together) is
    // a CREATE-time invariant; an imported workspace round-trips the rebaseline
    // alone (ADR 0010/0015), so this is a real shape the action must accept.
    await store.liabilities.addBalanceRebaseline({
      annualInterestRate: "0.02",
      baselineDate: "2026-03-10",
      endDate: "2026-06-10",
      id: "base1",
      liabilityId: "mortgage",
      nextPaymentDate: "2026-04-10",
      outstandingBalanceMinor: 90_000_00,
      startsAtBaseline: true,
    });

    const url = await runAction(
      form({
        id: "mortgage",
        rbBalanceDate: "2026-05-10",
        rbOutstandingBalance: "80.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("debt_recalibrated");

    const rebaselines = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(rebaselines).toHaveLength(2);
    const recalibrated = rebaselines.find((r) => r.baselineDate === "2026-05-10")!;
    expect(recalibrated).toMatchObject({
      annualInterestRate: "0.02",
      outstandingBalanceMinor: 80_000_00,
      startsAtBaseline: false,
    });

    store.close();
  });

  test("refuses a balance date before an ORIGIN plan's own disbursement date (#678 review)", async () => {
    const store = await seedAmortizableMortgage(); // plan disbursed 2026-01-15

    const url = await runAction(
      form({
        id: "mortgage",
        rbBalanceDate: "2025-12-01",
        rbOutstandingBalance: "150.000,00",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });

  test("refuses a debt with no amortization plan to recalibrate", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.liabilities.createLiability({
      balanceMinor: 5_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "amortizable");

    const url = await runAction(
      form({ id: "card", rbBalanceDate: "2026-06-15", rbOutstandingBalance: "1.000,00" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceRebaselines("card")).toHaveLength(0);

    store.close();
  });
});

describe("recalibrateDebtBalanceAction — demo write-gating", () => {
  test("blocks the mutation in demo mode and leaves the store untouched", async () => {
    const store = await seedAmortizableMortgage();
    mockPersonaCookie = "familia";

    const url = await runAction(
      form({
        currentUrl: "/patrimonio/mortgage/editar",
        id: "mortgage",
        rbBalanceDate: "2026-06-15",
        rbOutstandingBalance: "140.000,00",
      }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });
});
