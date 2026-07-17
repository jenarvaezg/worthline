/**
 * Historical snapshots from debt balances (PRD #109, slice 9 / #118).
 *
 * Integration tests against a real in-memory store: declaring/editing/deleting a
 * debt event with a PAST date (an amortization plan, a balance anchor, a rate
 * revision) generates/overwrites the snapshot at the affected date(s) — valuing
 * the liability from its debt curve via debtBalanceAtDate — and ripples the
 * existing snapshots after it. Future events generate nothing. A liability with
 * no debt model keeps the last-known-value basis (no regression). Housing equity
 * in a past snapshot subtracts the REAL historical mortgage balance.
 */

import type { PersistenceTestStore as WorthlineStore } from "@db/testing";
import { createInMemoryStore } from "@db/testing";
import { amortizableBalanceAtDate, debtBalanceAtDate } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const TODAY = "2026-06-13";

async function snapAt(store: WorthlineStore, dateKey: string, scopeId?: string) {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  );
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await snapAt(store, dateKey))?.debts.amountMinor;
}

async function housingEquityAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await snapAt(store, dateKey))?.housingEquity.amountMinor;
}

async function holdingsReconcile(
  store: WorthlineStore,
  dateKey: string,
): Promise<boolean> {
  const snap = await snapAt(store, dateKey);
  if (!snap) return false;
  const rows = await store.snapshots.readSnapshotHoldings({
    scopeId: snap.scopeId,
    from: dateKey,
    to: dateKey,
  });
  const assets = rows
    .filter((r) => r.kind === "asset")
    .reduce((s, r) => s + r.valueMinor, 0);
  const debts = rows
    .filter((r) => r.kind === "liability")
    .reduce((s, r) => s + r.valueMinor, 0);
  return assets === snap.grossAssets.amountMinor && debts === snap.debts.amountMinor;
}

describe("historical snapshots from amortizable plans", () => {
  async function seedAmortizable(store: WorthlineStore): Promise<void> {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    // Some cash so the portfolio is never empty.
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");
  }

  test("a past plan generates a snapshot per past cuota with the curve balance", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);

    // ADR 0020: persist-and-ripple ride ONE store seam (kind derived behind it).
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2026-01-15",

        firstPaymentDate: "2026-02-15",
        termMonths: 240,
      },
      { today: TODAY },
    );

    // One snapshot per past payment boundary: 01-15..05-15 (06-15 is after today).
    for (const dateKey of [
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
    ]) {
      const expected = await store.liabilities.debtBalanceAtDate("mortgage", dateKey);
      expect(await debtsAt(store, dateKey)).toBe(expected);
      expect(await holdingsReconcile(store, dateKey)).toBe(true);
    }
    // The loan-start snapshot equals the initial capital.
    expect(await debtsAt(store, "2026-01-15")).toBe(150_000_00);
    // No future snapshot.
    expect(await snapAt(store, "2026-06-15")).toBeUndefined();
    store.close();
  });

  test("a between-cuota snapshot holds the last cuota's balance (step), not interpolated (#390, ADR 0031)", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);

    const PLAN = {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      initialCapitalMinor: 150_000_00,
      termMonths: 240,
    } as const;
    await store.command.createAmortizationPlan(
      { ...PLAN, id: "plan1", liabilityId: "mortgage" },
      { today: TODAY },
    );

    // An unrelated backdated fact dated BETWEEN two cuotas (2026-03-15 and
    // 2026-04-15) generates a full-portfolio snapshot there, valuing the mortgage
    // off its debt curve on that date — the "daily capture between events" case
    // (ADR 0005) the re-ripple is meant to flip from interpolated to step.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-03-20",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const stepValue = amortizableBalanceAtDate({ plan: PLAN, targetDate: "2026-03-20" });
    const lastCuotaValue = amortizableBalanceAtDate({
      plan: PLAN,
      targetDate: "2026-03-15",
    });
    const interpolatedValue = amortizableBalanceAtDate({
      plan: PLAN,
      targetDate: "2026-03-20",
      cadence: "interpolated",
    });
    // The step holds the LAST cuota's balance, and that genuinely differs from
    // what interpolation would have produced — so the assertion below has teeth.
    expect(stepValue).toBe(lastCuotaValue);
    expect(interpolatedValue).not.toBe(stepValue);

    // The between-cuota snapshot holds the stepped balance, not the interpolated one.
    expect(await debtsAt(store, "2026-03-20")).toBe(stepValue);
    // The cuota-date snapshot is unchanged (step == interpolation on the boundary).
    expect(await debtsAt(store, "2026-03-15")).toBe(lastCuotaValue);
    expect(await holdingsReconcile(store, "2026-03-20")).toBe(true);
    store.close();
  });

  test("a rate revision recalculates snapshots on or after the revision", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2026-01-15",

        firstPaymentDate: "2026-02-15",
        termMonths: 240,
      },
      { today: TODAY },
    );
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;

    const beforeRevision = (await debtsAt(store, "2026-02-15"))!;

    await store.command.addInterestRateRevision(
      {
        id: "rev1",
        newAnnualInterestRate: "0.06",
        planId,
        revisionDate: "2026-03-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    // Before the revision is untouched; on/after it matches the new curve.
    expect(await debtsAt(store, "2026-02-15")).toBe(beforeRevision);
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("a past early repayment overwrites its snapshot and recalculates after it", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2026-01-15",

        firstPaymentDate: "2026-02-15",
        termMonths: 240,
      },
      { today: TODAY },
    );
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;

    const beforeRepayment = (await debtsAt(store, "2026-02-15"))!;

    await store.command.addEarlyRepayment(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: "2026-03-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    // The cuota before the repayment is untouched …
    expect(await debtsAt(store, "2026-02-15")).toBe(beforeRepayment);
    // … and on/after it every snapshot matches the repayment-aware curve, with
    // the lump landing on its own date (a ~20.000€ drop versus the prior cuota).
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
      expect(await holdingsReconcile(store, dateKey)).toBe(true);
    }
    expect((await debtsAt(store, "2026-03-15"))!).toBeLessThan(
      beforeRepayment - 19_000_00,
    );
    store.close();
  });

  test("a mid-cycle early repayment recalculates the whole cuota cycle it lands in, not just from its raw date (#1042)", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const PLAN = {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      initialCapitalMinor: 150_000_00,
      termMonths: 240,
    } as const;
    await store.command.createAmortizationPlan(
      { ...PLAN, id: "plan1", liabilityId: "mortgage" },
      { today: TODAY },
    );
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;

    // An EXISTING snapshot INSIDE the cycle window — between the 03-15 cuota
    // boundary and the mid-cycle repayment date (03-20) — a daily-capture-style
    // snapshot the ripple must reach. An unrelated op on 03-18 generates it, valued
    // off the mortgage's debt curve on that date.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-03-18",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    // The cycle: the 03-15 boundary and the 03-18 in-window snapshot. Pre-lump both
    // hold the 03-15 cuota balance (step within a cuota cycle).
    const CYCLE = ["2026-03-15", "2026-03-18"];
    const preLump = (await debtsAt(store, "2026-03-18"))!;
    expect(preLump).toBe((await debtsAt(store, "2026-03-15"))!);

    // Register a mid-cycle lump dated 03-20 — after the 03-15 boundary, before the
    // 04-15 cuota. The live curve applies it from the 03-15 boundary (#182).
    await store.command.addEarlyRepayment(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: "2026-03-20",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    // Every snapshot in the cycle — including 03-15 and 03-18, both dated BEFORE the
    // raw 03-20 event — now matches the live curve (post-lump). Rippling from the
    // raw date would have left these at the pre-lump value forever (the bug).
    for (const dateKey of CYCLE) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
      expect(await holdingsReconcile(store, dateKey)).toBe(true);
    }
    // The in-window snapshot genuinely moved by the lump — proof the ripple reached
    // back to the cuota boundary rather than stopping at the raw event date.
    const postLump = (await debtsAt(store, "2026-03-18"))!;
    expect(preLump - postLump).toBeGreaterThan(19_000_00);

    // A later unrelated whole-plan ripple crossing the window does NOT rewrite any
    // figure the user already saw: the persisted history already equals the live
    // curve, so the silent-rewrite hazard is gone.
    await store.command.setLiabilityValuationCadence("mortgage", "step", {
      today: TODAY,
    });
    for (const dateKey of CYCLE) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    expect((await debtsAt(store, "2026-03-18"))!).toBe(postLump);
    store.close();
  });

  test("an early repayment dated exactly today updates its past cuota-boundary snapshot, never the future (#1042, ADR 0012)", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
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
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;

    // TODAY is 2026-06-13; a lump dated exactly today anchors to the 2026-05-15
    // cuota boundary (the largest boundary ≤ today). The ADR-0012 guard keys on the
    // RAW date, so a today-dated fact is allowed to ripple, but the from-date is the
    // PAST boundary — so its already-persisted boundary snapshot must reflect the
    // lump, while no future snapshot is ever fabricated.
    const beforeBoundary = (await debtsAt(store, "2026-05-15"))!;
    await store.command.addEarlyRepayment(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: TODAY,
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    // The past cuota-boundary snapshot now carries the lump and matches the live
    // curve; the prior cuota (04-15) is untouched; no history beyond today.
    expect(await debtsAt(store, "2026-05-15")).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", "2026-05-15"),
    );
    expect(beforeBoundary - (await debtsAt(store, "2026-05-15"))!).toBeGreaterThan(
      19_000_00,
    );
    expect(await snapAt(store, "2026-06-15")).toBeUndefined();
    store.close();
  });

  test("a mid-cycle rate revision ripples from its boundary and never diverges in-window (#1042)", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
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
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;

    // An existing in-window snapshot (03-18) between the 03-15 boundary and the
    // mid-cycle revision date (03-20).
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-03-18",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const beforeInWindow = (await debtsAt(store, "2026-03-18"))!;

    await store.command.addInterestRateRevision(
      { id: "rev1", newAnnualInterestRate: "0.06", planId, revisionDate: "2026-03-20" },
      { liabilityId: "mortgage", today: TODAY },
    );

    // Unlike an early repayment, a revision does NOT overwrite the start-of-cycle
    // balance (computeBoundaries only rewrites a boundary for a lump) — it changes
    // the payment, so the balance only moves from the NEXT cuota onward. The fix
    // still aligns the revision's ripple from-date to the 03-15 boundary (single
    // source of truth), and the contract that matters holds: every snapshot in the
    // cycle matches the live curve, the in-window 03-18 value is unchanged (no
    // spurious rewrite), and a later cuota does move to the revised curve.
    for (const dateKey of ["2026-03-15", "2026-03-18"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    expect(await debtsAt(store, "2026-03-18")).toBe(beforeInWindow);
    expect(await debtsAt(store, "2026-04-15")).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", "2026-04-15"),
    );
    store.close();
  });

  test("future plan generates nothing", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2030-01-15",

        firstPaymentDate: "2030-02-15",
        termMonths: 240,
      },
      { today: TODAY },
    );
    expect(await store.snapshots.readSnapshots()).toHaveLength(0);
    store.close();
  });
});

describe("historical snapshots from current-state re-baselines", () => {
  async function seedCurrentStateDebt(store: WorthlineStore): Promise<void> {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
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
  }

  test("declaring a current-state baseline starts the debt on that date only", async () => {
    const store = await createInMemoryStore();
    await seedCurrentStateDebt(store);

    await store.command.addBalanceRebaseline(
      {
        annualInterestRate: "0",
        baselineDate: "2026-03-10",
        endDate: "2026-06-10",
        id: "base1",
        liabilityId: "mortgage",
        nextPaymentDate: "2026-04-10",
        outstandingBalanceMinor: 90_000_00,
        startsAtBaseline: true,
      },
      { today: TODAY },
    );

    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-02-01",
        id: "op-before",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    expect(await debtsAt(store, "2026-02-01")).toBe(0);
    expect(await debtsAt(store, "2026-03-10")).toBe(90_000_00);
    expect(await debtsAt(store, "2026-04-10")).toBe(60_000_00);
    expect(await holdingsReconcile(store, "2026-03-10")).toBe(true);
    store.close();
  });

  test("editing a baseline ripples from the earlier baseline date and leaves earlier snapshots untouched", async () => {
    const store = await createInMemoryStore();
    await seedCurrentStateDebt(store);

    await store.command.addBalanceRebaseline(
      {
        annualInterestRate: "0",
        baselineDate: "2026-03-10",
        endDate: "2026-06-10",
        id: "base1",
        liabilityId: "mortgage",
        nextPaymentDate: "2026-04-10",
        outstandingBalanceMinor: 90_000_00,
        startsAtBaseline: true,
      },
      { today: TODAY },
    );
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-02-01",
        id: "op-before",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
    const beforeBaselineSnapshot = await debtsAt(store, "2026-02-01");

    const changes = await store.command.updateBalanceRebaseline(
      "base1",
      { outstandingBalanceMinor: 120_000_00 },
      { today: TODAY },
    );

    expect(changes).toBe(1);
    expect(await debtsAt(store, "2026-02-01")).toBe(beforeBaselineSnapshot);
    expect(await debtsAt(store, "2026-03-10")).toBe(120_000_00);
    expect(await debtsAt(store, "2026-04-10")).toBe(80_000_00);
    store.close();
  });

  test("deleting the sole starts-at-baseline re-baseline of a plan-less liability fails cleanly and deletes nothing", async () => {
    const store = await createInMemoryStore();
    await seedCurrentStateDebt(store);

    await store.command.addBalanceRebaseline(
      {
        annualInterestRate: "0",
        baselineDate: "2026-03-10",
        endDate: "2026-06-10",
        id: "base1",
        liabilityId: "mortgage",
        nextPaymentDate: "2026-04-10",
        outstandingBalanceMinor: 90_000_00,
        startsAtBaseline: true,
      },
      { today: TODAY },
    );

    // The liability has no amortization plan row (ADR 0056 current-state entry):
    // "base1" is the only fact defining its debt curve. Deleting it would leave
    // debtBalanceAtDate with nothing to derive from — refuse instead of silently
    // flattening the curve.
    await expect(
      store.command.deleteBalanceRebaseline("base1", { today: TODAY }),
    ).rejects.toThrow(/amortization plan/i);

    const remaining = await store.liabilities.readBalanceRebaselines("mortgage");
    expect(remaining).toHaveLength(1);
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2026-03-10")).toBe(
      90_000_00,
    );
    store.close();
  });
});

describe("historical snapshots from balance anchors", () => {
  async function seedRevolving(store: WorthlineStore): Promise<void> {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");
  }

  test("a past anchor generates a snapshot at that date with the anchor balance", async () => {
    const store = await createInMemoryStore();
    await seedRevolving(store);

    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    expect(await debtsAt(store, "2025-01-01")).toBe(3_000_00);
    expect(await holdingsReconcile(store, "2025-01-01")).toBe(true);
    store.close();
  });

  test("a between-anchor snapshot holds the most recent anchor (step), not interpolated (#392, ADR 0031)", async () => {
    const store = await createInMemoryStore();
    await seedRevolving(store);

    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 10_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-07-01",
        balanceMinor: 4_000_00,
        id: "an2",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    // An unrelated backdated fact between the anchors generates a full-portfolio
    // snapshot there, valuing the revolving card off its anchor curve on that date.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2025-04-01",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const anchors = [
      { anchorDate: "2025-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2025-07-01", balanceMinor: 4_000_00 },
    ];
    const stepValue = debtBalanceAtDate({
      debtModel: "revolving",
      anchors,
      currentBalanceMinor: 1_000_00,
      targetDate: "2025-04-01",
    });
    const interpolatedValue = debtBalanceAtDate({
      debtModel: "revolving",
      cadence: "interpolated",
      anchors,
      currentBalanceMinor: 1_000_00,
      targetDate: "2025-04-01",
    });
    // The step holds the 2025-01-01 anchor; interpolation would give something else.
    expect(stepValue).toBe(10_000_00);
    expect(interpolatedValue).not.toBe(stepValue);

    // The between-anchor snapshot holds the stepped balance, not the interpolated one.
    expect(await debtsAt(store, "2025-04-01")).toBe(stepValue);
    // Anchor-date snapshots are unchanged.
    expect(await debtsAt(store, "2025-01-01")).toBe(10_000_00);
    expect(await debtsAt(store, "2025-07-01")).toBe(4_000_00);
    expect(await holdingsReconcile(store, "2025-04-01")).toBe(true);
    store.close();
  });

  test("a backdated anchor ripples the snapshots after it", async () => {
    const store = await createInMemoryStore();
    await seedRevolving(store);

    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-06-01",
        balanceMinor: 5_000_00,
        id: "an2",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(await debtsAt(store, "2025-06-01")).toBe(5_000_00);

    // A backdated anchor at 2025-01-01 with a lower balance: its own snapshot is
    // generated, and the 2025-06-01 one (now between two anchors) stays its
    // anchor truth (5_000_00).
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 2_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(await debtsAt(store, "2025-01-01")).toBe(2_000_00);
    expect(await debtsAt(store, "2025-06-01")).toBe(5_000_00);
    store.close();
  });

  test("editing an anchor recalculates the affected snapshot", async () => {
    const store = await createInMemoryStore();
    await seedRevolving(store);
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(await debtsAt(store, "2025-01-01")).toBe(3_000_00);

    await store.command.updateBalanceAnchor(
      "an1",
      { balanceMinor: 3_500_00 },
      { today: TODAY },
    );
    expect(await debtsAt(store, "2025-01-01")).toBe(3_500_00);
    store.close();
  });

  test("editing an anchor's date derives the ripple from-date behind the seam (ADR 0025)", async () => {
    const store = await createInMemoryStore();
    await seedRevolving(store);
    // Earlier anchor (3_000_00) and a later one (8_000_00). The 2025-01-01 snapshot
    // is pinned to its own anchor (3_000_00) while an1 sits on that date.
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-06-01",
        balanceMinor: 8_000_00,
        id: "an2",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(await debtsAt(store, "2025-01-01")).toBe(3_000_00);

    // Move an1 LATER (2025-01-01 → 2025-09-01) WITHOUT telling the seam the old
    // date. The from-date must be min(old, new) = the OLD date (2025-01-01), so the
    // stale 2025-01-01 snapshot is recalculated. With an1 gone from that date, the
    // earliest anchor is now an2 (8_000_00), and "before the first anchor is flat at
    // the first balance" → the 2025-01-01 snapshot must flip 3_000_00 → 8_000_00. If
    // the seam wrongly rippled from the NEW date (2025-09-01), it would stay stale.
    const changes = await store.command.updateBalanceAnchor(
      "an1",
      { anchorDate: "2025-09-01" },
      { today: TODAY },
    );

    expect(changes).toBe(1);
    expect(await debtsAt(store, "2025-01-01")).toBe(8_000_00);
    store.close();
  });

  test("future anchor generates nothing", async () => {
    const store = await createInMemoryStore();
    await seedRevolving(store);
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2030-01-01",
        balanceMinor: 9_000_00,
        id: "anF",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(await store.snapshots.readSnapshots()).toHaveLength(0);
    store.close();
  });
});

describe("historical housing equity from a real mortgage curve", () => {
  test("equity at a past date = housing value(date) − mortgage balance(date)", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.liabilities.createLiability({
      associatedAssetId: "piso",
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("mortgage", "amortizable");

    // Housing curve: an appraisal anchor in the past. The anchor persist + ripple
    // ride the valuation seam (generates the 2025-01-01 snapshot).
    await store.command.addValuationAnchor(
      {
        adjustsPriorCurve: true,
        assetId: "piso",
        id: "v1",
        valuationDate: "2025-01-01",
        valueMinor: 180_000_00,
      },
      { today: TODAY },
    );
    // Mortgage amortization plan starting in the past — the plan persist + ripple
    // ride the debt seam, re-valuing the debt on the 2025-01-01 snapshot too.
    await store.command.createAmortizationPlan(
      {
        annualInterestRate: "0.03",
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2024-01-01",

        firstPaymentDate: "2024-02-01",
        termMonths: 240,
      },
      { today: TODAY },
    );

    // Housing value at 2025-01-01 is the appraisal (180k). The mortgage balance
    // is the REAL curve balance on 2025-01-01, NOT the last-known 100k.
    const valueOnDate = 180_000_00;
    const balanceOnDate = await store.liabilities.debtBalanceAtDate(
      "mortgage",
      "2025-01-01",
    );
    expect(balanceOnDate).toBeGreaterThan(100_000_00); // it was higher a year in
    expect(await housingEquityAt(store, "2025-01-01")).toBe(valueOnDate - balanceOnDate);
    expect(await debtsAt(store, "2025-01-01")).toBe(balanceOnDate);
    expect(await holdingsReconcile(store, "2025-01-01")).toBe(true);

    // The frozen securesHousing signal persists and reads back (#180): the
    // mortgage row secures the housing asset → true; the housing asset itself
    // is an asset → false. No live foreign key into holdings is consulted.
    const rows = await store.snapshots.readSnapshotHoldings({
      // Individual mode freezes rows under the single household scope (#269).
      scopeId: "household",
      from: "2025-01-01",
      to: "2025-01-01",
    });
    expect(rows.find((r) => r.holdingId === "mortgage")?.securesHousing).toBe(true);
    expect(rows.find((r) => r.holdingId === "piso")?.securesHousing).toBe(false);
    store.close();
  });
});

describe("multi-member ownership", () => {
  test("a 50/50 mortgage splits the historical balance per scope", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 4_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    // Household scope sees the whole 4_000_00; each member sees their 2_000_00.
    expect(await debtsAt(store, "2025-01-01")).toBe(4_000_00); // default scope (household)
    expect((await snapAt(store, "2025-01-01", "mJ"))?.debts.amountMinor).toBe(2_000_00);
    expect((await snapAt(store, "2025-01-01", "mA"))?.debts.amountMinor).toBe(2_000_00);
    expect(await holdingsReconcile(store, "2025-01-01")).toBe(true);
    store.close();
  });
});

describe("plan deletion recalculates snapshots to currentBalance basis", () => {
  async function seedAmortizableForDelete(store: WorthlineStore): Promise<void> {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 100_000_00,
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
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2026-01-15",

        firstPaymentDate: "2026-02-15",
        termMonths: 240,
      },
      { today: TODAY },
    );
  }

  test("RED: a plain plan delete (no ripple) leaves snapshots frozen at plan balances, not currentBalance", async () => {
    // Documents the BROKEN action wiring: the seed already rippled the plan
    // (createAmortizationPlanAndRipple), so the snapshot carries the plan balance.
    // A plain deleteAmortizationPlan (no ripple) cannot reset it — the plan ripple
    // early-returns once curve.plan is null — so the snapshot keeps the plan-
    // derived balance forever. This is exactly why the delete must ride the seam
    // (the GREEN test below), which captures startDate and ripples the planless
    // curve. We assert the wrong outcome here to pin the contrast.
    const store = await createInMemoryStore();
    await seedAmortizableForDelete(store);

    const planBalance = await store.liabilities.debtBalanceAtDate(
      "mortgage",
      "2026-01-15",
    );
    expect(planBalance).not.toBe(100_000_00); // plan balance ≠ currentBalance
    // The seed's seam ripple already froze the snapshot at the plan balance.
    expect(await debtsAt(store, "2026-01-15")).toBe(planBalance);

    // Broken wiring: a plain delete with no ripple.
    await store.liabilities.deleteAmortizationPlan("plan1");

    // Snapshot is still frozen at the plan balance — NOT reset to currentBalance.
    expect(await debtsAt(store, "2026-01-15")).toBe(planBalance);
    expect(await debtsAt(store, "2026-01-15")).not.toBe(100_000_00);
    store.close();
  });

  test("GREEN: delete plan first, then ripple amortizable-revision from startDate resets snapshots to currentBalance", async () => {
    // This is the canonical correctness test for the fixed action wiring:
    //   1. capture startDate before deleting
    //   2. deleteAmortizationPlan
    //   3. ripple(amortizable-revision, fromDateKey=startDate)
    //      → curve now has no plan, debtBalanceAtDate falls back to currentBalance
    //      → every existing snapshot ≥ startDate is recalculated to currentBalance
    const store = await createInMemoryStore();
    await seedAmortizableForDelete(store);

    const planBalance = await store.liabilities.debtBalanceAtDate(
      "mortgage",
      "2026-01-15",
    );
    expect(planBalance).not.toBe(100_000_00); // confirm pre-condition

    // The seam captures the plan's disbursement date, deletes, then ripples the
    // planless curve (amortizable-revision recalc from start) — all atomically.
    await store.command.deleteAmortizationPlan({
      liabilityId: "mortgage",
      today: TODAY,
    });

    // All snapshots on or after the old plan start now reflect currentBalance (100k).
    for (const dateKey of [
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
    ]) {
      expect(await debtsAt(store, dateKey)).toBe(100_000_00);
      expect(await holdingsReconcile(store, dateKey)).toBe(true);
    }
    store.close();
  });
});

describe("no regression", () => {
  test("a liability with no debt model keeps last-known-value in history", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 5_000_00,
      currency: "EUR",
      id: "loan",
      name: "Prestamo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    // No debt model set. A modeled debt drives the ripple to generate a snapshot.
    await store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 2_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    // The no-model loan keeps its current balance (no audit history) in the
    // generated snapshot — its debt = 5_000_00, card = 2_000_00 → debts 7_000_00.
    expect(await debtsAt(store, "2025-01-01")).toBe(7_000_00);
    expect(await holdingsReconcile(store, "2025-01-01")).toBe(true);
    store.close();
  });
});

describe("debt dated-fact seams (ADR 0020) — persist + ripple are one transaction", () => {
  async function seedAmortizable(store: WorthlineStore): Promise<void> {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 100_000_00,
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
        id: "plan1",
        initialCapitalMinor: 150_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2026-01-15",
        firstPaymentDate: "2026-02-15",
        termMonths: 240,
      },
      { today: TODAY },
    );
  }

  async function seedRevolving(store: WorthlineStore): Promise<void> {
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");
  }

  test("updateAmortizationPlanAndRipple rewrites the per-cuota history from the new plan", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;

    const changes = await store.command.updateAmortizationPlan(
      planId,
      { initialCapitalMinor: 120_000_00 },
      { liabilityId: "mortgage", today: TODAY },
    );

    expect(changes).toBe(1);
    // Every past-cuota snapshot now matches the new (120k) plan curve.
    for (const dateKey of ["2026-01-15", "2026-02-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("updateInterestRateRevisionAndRipple recalculates from the earlier of old/new date", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;
    await store.command.addInterestRateRevision(
      { id: "rev1", newAnnualInterestRate: "0.06", planId, revisionDate: "2026-04-15" },
      { liabilityId: "mortgage", today: TODAY },
    );
    // 2026-05-15 is after the original revision (04-15) → it carries its effect.
    const before0515 = (await debtsAt(store, "2026-05-15"))!;

    // Move the revision earlier (04-15 → 03-15): the seam ripples from the earlier
    // date, so the new-rate curve now applies from 03-15 forward.
    const changes = await store.command.updateInterestRateRevision(
      "rev1",
      { revisionDate: "2026-03-15" },
      { today: TODAY },
    );

    expect(changes).toBe(1);
    // The recalc spans from 03-15 (the earlier of old/new) and every snapshot
    // matches the moved-revision curve.
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    // The revision biting one month earlier changes the 05-15 balance.
    expect(await debtsAt(store, "2026-05-15")).not.toBe(before0515);
    store.close();
  });

  test("editing a revision's date derives the ripple from-date behind the seam (ADR 0025)", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;
    await store.command.addInterestRateRevision(
      { id: "rev1", newAnnualInterestRate: "0.06", planId, revisionDate: "2026-04-15" },
      { liabilityId: "mortgage", today: TODAY },
    );
    // 2026-05-15 is after the original revision (04-15) → it carries its effect.
    const before0515 = (await debtsAt(store, "2026-05-15"))!;

    // Move the revision EARLIER (04-15 → 03-15) WITHOUT telling the seam the old
    // date. The from-date must be min(old, new) = the OLD date (2026-04-15) so the
    // 04-15 snapshot recomputes too; if the seam wrongly rippled only from the new
    // date it would still recalc 04-15 here, so we also assert 05-15 moves (the
    // new-rate curve now bites a month earlier across the window).
    const changes = await store.command.updateInterestRateRevision(
      "rev1",
      { revisionDate: "2026-03-15" },
      { today: TODAY },
    );

    expect(changes).toBe(1);
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    expect(await debtsAt(store, "2026-05-15")).not.toBe(before0515);
    store.close();
  });

  test("editing a repayment's date derives the ripple from-date behind the seam (ADR 0025)", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;
    await store.command.addEarlyRepayment(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: "2026-04-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );
    const before0515 = (await debtsAt(store, "2026-05-15"))!;

    // Move the repayment EARLIER (04-15 → 03-15) WITHOUT telling the seam the old
    // date. The from-date must be min(old, new) = the OLD date (2026-04-15), so the
    // window from 03-15 forward recomputes against the moved-repayment curve.
    const changes = await store.command.updateEarlyRepayment(
      "erp1",
      { repaymentDate: "2026-03-15" },
      { today: TODAY },
    );

    expect(changes).toBe(1);
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    expect(await debtsAt(store, "2026-05-15")).not.toBe(before0515);
    store.close();
  });

  test("deleteInterestRateRevisionAndRipple recalculates the snapshots from its date", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;
    await store.command.addInterestRateRevision(
      { id: "rev1", newAnnualInterestRate: "0.06", planId, revisionDate: "2026-03-15" },
      { liabilityId: "mortgage", today: TODAY },
    );

    const changes = await store.command.deleteInterestRateRevision("rev1", {
      today: TODAY,
    });

    expect(changes).toBe(1);
    // With the revision gone, on/after its date matches the plain-plan curve.
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("updateEarlyRepaymentAndRipple recalculates from the earlier of old/new date", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;
    await store.command.addEarlyRepayment(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: "2026-04-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    const changes = await store.command.updateEarlyRepayment(
      "erp1",
      { repaymentDate: "2026-03-15" },
      { today: TODAY },
    );

    expect(changes).toBe(1);
    expect(await debtsAt(store, "2026-03-15")).toBe(
      await store.liabilities.debtBalanceAtDate("mortgage", "2026-03-15"),
    );
    store.close();
  });

  test("deleteEarlyRepaymentAndRipple recalculates the snapshots from its date", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);
    const planId = (await store.liabilities.readAmortizationPlan("mortgage"))!.id;
    await store.command.addEarlyRepayment(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: "2026-03-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    const changes = await store.command.deleteEarlyRepayment("erp1", { today: TODAY });

    expect(changes).toBe(1);
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(await debtsAt(store, dateKey)).toBe(
        await store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("deleteBalanceAnchorAndRipple recalculates the affected snapshots", async () => {
    const store = await createInMemoryStore();
    await seedRevolving(store);
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    await store.command.addBalanceAnchor(
      {
        anchorDate: "2025-06-01",
        balanceMinor: 6_000_00,
        id: "an2",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(await debtsAt(store, "2025-01-01")).toBe(3_000_00);

    // Deleting the earlier anchor: 2025-01-01 now back-extrapolates from the only
    // remaining anchor (6_000_00 flat, no curve).
    const changes = await store.command.deleteBalanceAnchor("an1", { today: TODAY });

    expect(changes).toBe(1);
    expect(await debtsAt(store, "2025-01-01")).toBe(6_000_00);
    store.close();
  });

  test("deleteBalanceRebaselineAndRipple reverts the curve to the plan from the rebaseline date forward, leaving earlier snapshots untouched", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);

    const beforeRebaseline = (await debtsAt(store, "2026-03-15"))!;

    await store.command.addBalanceRebaseline(
      {
        annualInterestRate: "0.03",
        baselineDate: "2026-04-15",
        endDate: "2046-04-15",
        id: "base1",
        liabilityId: "mortgage",
        nextPaymentDate: "2026-05-15",
        outstandingBalanceMinor: 140_000_00,
      },
      { today: TODAY },
    );
    const rebaselinedAt0415 = (await debtsAt(store, "2026-04-15"))!;
    const rebaselinedAt0515 = (await debtsAt(store, "2026-05-15"))!;
    expect(rebaselinedAt0415).toBe(140_000_00);

    const changes = await store.command.deleteBalanceRebaseline("base1", {
      today: TODAY,
    });

    expect(changes).toBe(1);
    // Snapshots before the rebaseline's own date were never touched by either
    // the rebaseline or its deletion.
    expect(await debtsAt(store, "2026-03-15")).toBe(beforeRebaseline);
    // On/after the rebaseline date the curve reverts to the plain-plan balance —
    // the rebaseline's figures are gone.
    const planOnlyAt0415 = await store.liabilities.debtBalanceAtDate(
      "mortgage",
      "2026-04-15",
    );
    const planOnlyAt0515 = await store.liabilities.debtBalanceAtDate(
      "mortgage",
      "2026-05-15",
    );
    expect(await debtsAt(store, "2026-04-15")).toBe(planOnlyAt0415);
    expect(await debtsAt(store, "2026-05-15")).toBe(planOnlyAt0515);
    expect(planOnlyAt0415).not.toBe(rebaselinedAt0415);
    expect(planOnlyAt0515).not.toBe(rebaselinedAt0515);
    store.close();
  });
});
