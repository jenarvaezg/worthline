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
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { WorthlineStore } from "../src/index";

const TODAY = "2026-06-13";

function snapAt(store: WorthlineStore, dateKey: string, scopeId?: string) {
  return store.snapshots.readSnapshots(scopeId).find((snap) => snap.dateKey === dateKey);
}

function debtsAt(store: WorthlineStore, dateKey: string): number | undefined {
  return snapAt(store, dateKey)?.debts.amountMinor;
}

function housingEquityAt(store: WorthlineStore, dateKey: string): number | undefined {
  return snapAt(store, dateKey)?.housingEquity.amountMinor;
}

function holdingsReconcile(store: WorthlineStore, dateKey: string): boolean {
  const snap = snapAt(store, dateKey);
  if (!snap) return false;
  const rows = store.snapshots.readSnapshotHoldings({
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
  function seedAmortizable(store: WorthlineStore): void {
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    // Some cash so the portfolio is never empty.
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    store.liabilities.createLiability({
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    store.liabilities.setDebtModel("mortgage", "amortizable");
  }

  test("a past plan generates a snapshot per past cuota with the curve balance", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);

    // ADR 0020: persist-and-ripple ride ONE store seam (kind derived behind it).
    store.createAmortizationPlanAndRipple(
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
      const expected = store.liabilities.debtBalanceAtDate("mortgage", dateKey);
      expect(debtsAt(store, dateKey)).toBe(expected);
      expect(holdingsReconcile(store, dateKey)).toBe(true);
    }
    // The loan-start snapshot equals the initial capital.
    expect(debtsAt(store, "2026-01-15")).toBe(150_000_00);
    // No future snapshot.
    expect(snapAt(store, "2026-06-15")).toBeUndefined();
    store.close();
  });

  test("a rate revision recalculates snapshots on or after the revision", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    store.createAmortizationPlanAndRipple(
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
    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;

    const beforeRevision = debtsAt(store, "2026-02-15")!;

    store.addInterestRateRevisionAndRipple(
      {
        id: "rev1",
        newAnnualInterestRate: "0.06",
        planId,
        revisionDate: "2026-03-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    // Before the revision is untouched; on/after it matches the new curve.
    expect(debtsAt(store, "2026-02-15")).toBe(beforeRevision);
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(debtsAt(store, dateKey)).toBe(
        store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("a past early repayment overwrites its snapshot and recalculates after it", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    store.createAmortizationPlanAndRipple(
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
    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;

    const beforeRepayment = debtsAt(store, "2026-02-15")!;

    store.addEarlyRepaymentAndRipple(
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
    expect(debtsAt(store, "2026-02-15")).toBe(beforeRepayment);
    // … and on/after it every snapshot matches the repayment-aware curve, with
    // the lump landing on its own date (a ~20.000€ drop versus the prior cuota).
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(debtsAt(store, dateKey)).toBe(
        store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
      expect(holdingsReconcile(store, dateKey)).toBe(true);
    }
    expect(debtsAt(store, "2026-03-15")!).toBeLessThan(beforeRepayment - 19_000_00);
    store.close();
  });

  test("future plan generates nothing", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    store.createAmortizationPlanAndRipple(
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
    expect(store.snapshots.readSnapshots()).toHaveLength(0);
    store.close();
  });
});

describe("historical snapshots from balance anchors", () => {
  function seedRevolving(store: WorthlineStore): void {
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    store.liabilities.setDebtModel("card", "revolving");
  }

  test("a past anchor generates a snapshot at that date with the anchor balance", () => {
    const store = createInMemoryStore();
    seedRevolving(store);

    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    expect(debtsAt(store, "2025-01-01")).toBe(3_000_00);
    expect(holdingsReconcile(store, "2025-01-01")).toBe(true);
    store.close();
  });

  test("a backdated anchor ripples the snapshots after it", () => {
    const store = createInMemoryStore();
    seedRevolving(store);

    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-06-01",
        balanceMinor: 5_000_00,
        id: "an2",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(debtsAt(store, "2025-06-01")).toBe(5_000_00);

    // A backdated anchor at 2025-01-01 with a lower balance: its own snapshot is
    // generated, and the 2025-06-01 one (now between two anchors) stays its
    // anchor truth (5_000_00).
    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 2_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(debtsAt(store, "2025-01-01")).toBe(2_000_00);
    expect(debtsAt(store, "2025-06-01")).toBe(5_000_00);
    store.close();
  });

  test("editing an anchor recalculates the affected snapshot", () => {
    const store = createInMemoryStore();
    seedRevolving(store);
    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(debtsAt(store, "2025-01-01")).toBe(3_000_00);

    store.updateBalanceAnchorAndRipple(
      "an1",
      { balanceMinor: 3_500_00 },
      { liabilityId: "card", previousAnchorDate: "2025-01-01", today: TODAY },
    );
    expect(debtsAt(store, "2025-01-01")).toBe(3_500_00);
    store.close();
  });

  test("future anchor generates nothing", () => {
    const store = createInMemoryStore();
    seedRevolving(store);
    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2030-01-01",
        balanceMinor: 9_000_00,
        id: "anF",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(store.snapshots.readSnapshots()).toHaveLength(0);
    store.close();
  });
});

describe("historical housing equity from a real mortgage curve", () => {
  test("equity at a past date = housing value(date) − mortgage balance(date)", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    store.liabilities.createLiability({
      associatedAssetId: "piso",
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    store.liabilities.setDebtModel("mortgage", "amortizable");

    // Housing curve: an appraisal anchor in the past.
    store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "piso",
      id: "v1",
      valuationDate: "2025-01-01",
      valueMinor: 180_000_00,
    });
    // Mortgage amortization plan starting in the past.
    store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.03",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      disbursementDate: "2024-01-01",

      firstPaymentDate: "2024-02-01",
      termMonths: 240,
    });

    // Ripple the housing anchor first (generates the 2025-01-01 snapshot), then
    // the mortgage plan, which must re-value the debt on that snapshot too.
    store.rippleHistoricalSnapshotsForValuation({
      assetId: "piso",
      fromDateKey: "2025-01-01",
      today: TODAY,
    });
    store.rippleHistoricalSnapshotsForDebt({
      liabilityId: "mortgage",
      kind: "amortizable-plan",
      today: TODAY,
    });

    // Housing value at 2025-01-01 is the appraisal (180k). The mortgage balance
    // is the REAL curve balance on 2025-01-01, NOT the last-known 100k.
    const valueOnDate = 180_000_00;
    const balanceOnDate = store.liabilities.debtBalanceAtDate("mortgage", "2025-01-01");
    expect(balanceOnDate).toBeGreaterThan(100_000_00); // it was higher a year in
    expect(housingEquityAt(store, "2025-01-01")).toBe(valueOnDate - balanceOnDate);
    expect(debtsAt(store, "2025-01-01")).toBe(balanceOnDate);
    expect(holdingsReconcile(store, "2025-01-01")).toBe(true);

    // The frozen securesHousing signal persists and reads back (#180): the
    // mortgage row secures the housing asset → true; the housing asset itself
    // is an asset → false. No live foreign key into holdings is consulted.
    const rows = store.snapshots.readSnapshotHoldings({
      scopeId: "mJ",
      from: "2025-01-01",
      to: "2025-01-01",
    });
    expect(rows.find((r) => r.holdingId === "mortgage")?.securesHousing).toBe(true);
    expect(rows.find((r) => r.holdingId === "piso")?.securesHousing).toBe(false);
    store.close();
  });
});

describe("multi-member ownership", () => {
  test("a 50/50 mortgage splits the historical balance per scope", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    store.assets.createManualAsset({
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
    store.liabilities.createLiability({
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
    store.liabilities.setDebtModel("card", "revolving");
    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 4_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    // Household scope sees the whole 4_000_00; each member sees their 2_000_00.
    expect(debtsAt(store, "2025-01-01")).toBe(4_000_00); // default scope (household)
    expect(snapAt(store, "2025-01-01", "mJ")?.debts.amountMinor).toBe(2_000_00);
    expect(snapAt(store, "2025-01-01", "mA")?.debts.amountMinor).toBe(2_000_00);
    expect(holdingsReconcile(store, "2025-01-01")).toBe(true);
    store.close();
  });
});

describe("plan deletion recalculates snapshots to currentBalance basis", () => {
  function seedAmortizableForDelete(store: WorthlineStore): void {
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    store.liabilities.createLiability({
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    store.liabilities.setDebtModel("mortgage", "amortizable");
    store.createAmortizationPlanAndRipple(
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

  test("RED: ripple-before-delete leaves snapshots frozen at plan balances, not currentBalance", () => {
    // Documents the BROKEN action wiring: ripple(amortizable-plan) then delete.
    // The plan ripple early-returns when called after delete (curve.plan is null),
    // so doing it before delete means snapshots keep plan-derived balances forever.
    // This test asserts that specific (wrong) outcome so we can confirm it is what
    // the pre-fix action produces.
    const store = createInMemoryStore();
    seedAmortizableForDelete(store);

    const planBalance = store.liabilities.debtBalanceAtDate("mortgage", "2026-01-15");
    expect(planBalance).not.toBe(100_000_00); // plan balance ≠ currentBalance

    // Broken wiring: ripple with the plan still present, then delete.
    store.rippleHistoricalSnapshotsForDebt({
      liabilityId: "mortgage",
      kind: "amortizable-plan",
      today: TODAY,
    });
    store.liabilities.deleteAmortizationPlan("plan1");

    // Snapshot is still frozen at the plan balance — NOT reset to currentBalance.
    expect(debtsAt(store, "2026-01-15")).toBe(planBalance);
    expect(debtsAt(store, "2026-01-15")).not.toBe(100_000_00);
    store.close();
  });

  test("GREEN: delete plan first, then ripple amortizable-revision from startDate resets snapshots to currentBalance", () => {
    // This is the canonical correctness test for the fixed action wiring:
    //   1. capture startDate before deleting
    //   2. deleteAmortizationPlan
    //   3. ripple(amortizable-revision, fromDateKey=startDate)
    //      → curve now has no plan, debtBalanceAtDate falls back to currentBalance
    //      → every existing snapshot ≥ startDate is recalculated to currentBalance
    const store = createInMemoryStore();
    seedAmortizableForDelete(store);

    const planBalance = store.liabilities.debtBalanceAtDate("mortgage", "2026-01-15");
    expect(planBalance).not.toBe(100_000_00); // confirm pre-condition

    // The seam captures the plan's disbursement date, deletes, then ripples the
    // planless curve (amortizable-revision recalc from start) — all atomically.
    store.deleteAmortizationPlanAndRipple({
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
      expect(debtsAt(store, dateKey)).toBe(100_000_00);
      expect(holdingsReconcile(store, dateKey)).toBe(true);
    }
    store.close();
  });
});

describe("no regression", () => {
  test("a liability with no debt model keeps last-known-value in history", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    store.liabilities.createLiability({
      balanceMinor: 5_000_00,
      currency: "EUR",
      id: "loan",
      name: "Prestamo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    // No debt model set. A modeled debt drives the ripple to generate a snapshot.
    store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    store.liabilities.setDebtModel("card", "revolving");
    store.addBalanceAnchorAndRipple(
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
    expect(debtsAt(store, "2025-01-01")).toBe(7_000_00);
    expect(holdingsReconcile(store, "2025-01-01")).toBe(true);
    store.close();
  });
});

describe("debt dated-fact seams (ADR 0020) — persist + ripple are one transaction", () => {
  function seedAmortizable(store: WorthlineStore): void {
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    store.liabilities.createLiability({
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "mortgage",
    });
    store.liabilities.setDebtModel("mortgage", "amortizable");
    store.createAmortizationPlanAndRipple(
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

  function seedRevolving(store: WorthlineStore): void {
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "cash",
    });
    store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    store.liabilities.setDebtModel("card", "revolving");
  }

  test("updateAmortizationPlanAndRipple rewrites the per-cuota history from the new plan", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;

    const changes = store.updateAmortizationPlanAndRipple(
      planId,
      { initialCapitalMinor: 120_000_00 },
      { liabilityId: "mortgage", today: TODAY },
    );

    expect(changes).toBe(1);
    // Every past-cuota snapshot now matches the new (120k) plan curve.
    for (const dateKey of ["2026-01-15", "2026-02-15", "2026-05-15"]) {
      expect(debtsAt(store, dateKey)).toBe(
        store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("updateInterestRateRevisionAndRipple recalculates from the earlier of old/new date", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;
    store.addInterestRateRevisionAndRipple(
      { id: "rev1", newAnnualInterestRate: "0.06", planId, revisionDate: "2026-04-15" },
      { liabilityId: "mortgage", today: TODAY },
    );
    // 2026-05-15 is after the original revision (04-15) → it carries its effect.
    const before0515 = debtsAt(store, "2026-05-15")!;

    // Move the revision earlier (04-15 → 03-15): the seam ripples from the earlier
    // date, so the new-rate curve now applies from 03-15 forward.
    const changes = store.updateInterestRateRevisionAndRipple(
      "rev1",
      { revisionDate: "2026-03-15" },
      { liabilityId: "mortgage", previousRevisionDate: "2026-04-15", today: TODAY },
    );

    expect(changes).toBe(1);
    // The recalc spans from 03-15 (the earlier of old/new) and every snapshot
    // matches the moved-revision curve.
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(debtsAt(store, dateKey)).toBe(
        store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    // The revision biting one month earlier changes the 05-15 balance.
    expect(debtsAt(store, "2026-05-15")).not.toBe(before0515);
    store.close();
  });

  test("deleteInterestRateRevisionAndRipple recalculates the snapshots from its date", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;
    store.addInterestRateRevisionAndRipple(
      { id: "rev1", newAnnualInterestRate: "0.06", planId, revisionDate: "2026-03-15" },
      { liabilityId: "mortgage", today: TODAY },
    );

    const changes = store.deleteInterestRateRevisionAndRipple("rev1", {
      liabilityId: "mortgage",
      previousRevisionDate: "2026-03-15",
      today: TODAY,
    });

    expect(changes).toBe(1);
    // With the revision gone, on/after its date matches the plain-plan curve.
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(debtsAt(store, dateKey)).toBe(
        store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("updateEarlyRepaymentAndRipple recalculates from the earlier of old/new date", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;
    store.addEarlyRepaymentAndRipple(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: "2026-04-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    const changes = store.updateEarlyRepaymentAndRipple(
      "erp1",
      { repaymentDate: "2026-03-15" },
      { liabilityId: "mortgage", previousRepaymentDate: "2026-04-15", today: TODAY },
    );

    expect(changes).toBe(1);
    expect(debtsAt(store, "2026-03-15")).toBe(
      store.liabilities.debtBalanceAtDate("mortgage", "2026-03-15"),
    );
    store.close();
  });

  test("deleteEarlyRepaymentAndRipple recalculates the snapshots from its date", () => {
    const store = createInMemoryStore();
    seedAmortizable(store);
    const planId = store.liabilities.readAmortizationPlan("mortgage")!.id;
    store.addEarlyRepaymentAndRipple(
      {
        amountMinor: 20_000_00,
        id: "erp1",
        mode: "reduce-payment",
        planId,
        repaymentDate: "2026-03-15",
      },
      { liabilityId: "mortgage", today: TODAY },
    );

    const changes = store.deleteEarlyRepaymentAndRipple("erp1", {
      liabilityId: "mortgage",
      previousRepaymentDate: "2026-03-15",
      today: TODAY,
    });

    expect(changes).toBe(1);
    for (const dateKey of ["2026-03-15", "2026-04-15", "2026-05-15"]) {
      expect(debtsAt(store, dateKey)).toBe(
        store.liabilities.debtBalanceAtDate("mortgage", dateKey),
      );
    }
    store.close();
  });

  test("deleteBalanceAnchorAndRipple recalculates the affected snapshots", () => {
    const store = createInMemoryStore();
    seedRevolving(store);
    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 3_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-06-01",
        balanceMinor: 6_000_00,
        id: "an2",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    expect(debtsAt(store, "2025-01-01")).toBe(3_000_00);

    // Deleting the earlier anchor: 2025-01-01 now back-extrapolates from the only
    // remaining anchor (6_000_00 flat, no curve).
    const changes = store.deleteBalanceAnchorAndRipple("an1", {
      liabilityId: "card",
      previousAnchorDate: "2025-01-01",
      today: TODAY,
    });

    expect(changes).toBe(1);
    expect(debtsAt(store, "2025-01-01")).toBe(6_000_00);
    store.close();
  });
});
