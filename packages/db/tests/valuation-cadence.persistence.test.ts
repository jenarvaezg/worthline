/**
 * Per-holding valuation cadence (ADR 0031, #393): the stored column, its store
 * read/write API with audit, the threading into the debt engines, and the
 * re-ripple on a cadence change.
 *
 * Integration tests against a real in-memory store. setValuationCadence persists
 * and reads back (null clears), writes a `set_valuation_cadence` audit entry, and
 * — threaded end-to-end — a debt set to `interpolated` values its between-event
 * balances by interpolation again, while `step` (the default) holds the last
 * event flat. Changing the cadence re-ripples the affected snapshots; informal
 * debts are unaffected.
 */
import { describe, expect, test } from "vitest";

import { amortizableBalanceAtDate, debtBalanceAtDate } from "@worthline/domain";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-06-13";

async function snapAt(store: WorthlineStore, dateKey: string) {
  return (await store.snapshots.readSnapshots()).find((snap) => snap.dateKey === dateKey);
}

async function debtsAt(
  store: WorthlineStore,
  dateKey: string,
): Promise<number | undefined> {
  return (await snapAt(store, dateKey))?.debts.amountMinor;
}

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
}

describe("valuation cadence — store read/write + audit", () => {
  test("persists, reads back, null clears, and writes an audit entry", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);

    // Default (unset) reads as null (the engine treats null as `step`).
    expect(await store.liabilities.readValuationCadence("mortgage")).toBeNull();

    await store.liabilities.setValuationCadence("mortgage", "interpolated");
    expect(await store.liabilities.readValuationCadence("mortgage")).toBe("interpolated");

    await store.liabilities.setValuationCadence("mortgage", "step");
    expect(await store.liabilities.readValuationCadence("mortgage")).toBe("step");

    // Null clears it.
    await store.liabilities.setValuationCadence("mortgage", null);
    expect(await store.liabilities.readValuationCadence("mortgage")).toBeNull();

    const audit = await store.readAuditLog({ entityId: "mortgage" });
    const cadenceEntries = audit.filter((e) => e.action === "set_valuation_cadence");
    expect(cadenceEntries).toHaveLength(3);
    expect(cadenceEntries[0]).toMatchObject({
      action: "set_valuation_cadence",
      entityType: "liability",
      entityId: "mortgage",
      details: { cadence: "interpolated" },
    });
    expect(cadenceEntries[2]!.details).toEqual({ cadence: null });
    store.close();
  });

  test("the asset store exposes the same API with an asset audit entity", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);

    expect(await store.assets.readValuationCadence("cash")).toBeNull();
    await store.assets.setValuationCadence("cash", "interpolated");
    expect(await store.assets.readValuationCadence("cash")).toBe("interpolated");

    const audit = await store.readAuditLog({ entityId: "cash" });
    expect(audit.find((e) => e.action === "set_valuation_cadence")).toMatchObject({
      entityType: "asset",
      details: { cadence: "interpolated" },
    });
    store.close();
  });
});

describe("valuation cadence — threading into the debt engine", () => {
  test("a debt set to interpolated values between-cuota balances by interpolation", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);

    const PLAN = {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      initialCapitalMinor: 150_000_00,
      termMonths: 240,
    } as const;
    await store.createAmortizationPlanAndRipple(
      { ...PLAN, id: "plan1", liabilityId: "mortgage" },
      { today: TODAY },
    );

    const stepValue = amortizableBalanceAtDate({ plan: PLAN, targetDate: "2026-03-20" });
    const interpolatedValue = amortizableBalanceAtDate({
      plan: PLAN,
      targetDate: "2026-03-20",
      cadence: "interpolated",
    });
    expect(interpolatedValue).not.toBe(stepValue);

    // Default (null) → the engine reads the stepped balance through the store.
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2026-03-20")).toBe(
      stepValue,
    );

    // Opt into interpolation → the same read interpolates between cuotas.
    await store.liabilities.setValuationCadence("mortgage", "interpolated");
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2026-03-20")).toBe(
      interpolatedValue,
    );

    // Back to step → the stepped balance is restored.
    await store.liabilities.setValuationCadence("mortgage", "step");
    expect(await store.liabilities.debtBalanceAtDate("mortgage", "2026-03-20")).toBe(
      stepValue,
    );
    store.close();
  });
});

describe("valuation cadence — re-ripple on change (setValuationCadenceAndRipple)", () => {
  test("flipping an amortizable debt to interpolated re-ripples between-cuota snapshots", async () => {
    const store = await createInMemoryStore();
    await seedAmortizable(store);

    const PLAN = {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      initialCapitalMinor: 150_000_00,
      termMonths: 240,
    } as const;
    await store.createAmortizationPlanAndRipple(
      { ...PLAN, id: "plan1", liabilityId: "mortgage" },
      { today: TODAY },
    );

    // An unrelated backdated fact dated BETWEEN two cuotas snapshots the portfolio
    // there, valuing the mortgage off its curve (the "daily capture between events"
    // case the re-ripple must flip).
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.recordOperationAndRipple(
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
    const interpolatedValue = amortizableBalanceAtDate({
      plan: PLAN,
      targetDate: "2026-03-20",
      cadence: "interpolated",
    });
    expect(interpolatedValue).not.toBe(stepValue);

    // Default: the between-cuota snapshot holds the stepped balance.
    expect(await debtsAt(store, "2026-03-20")).toBe(stepValue);

    // Flip to interpolated AND re-ripple → the snapshot interpolates.
    await store.setValuationCadenceAndRipple("mortgage", "interpolated", {
      today: TODAY,
    });
    expect(await debtsAt(store, "2026-03-20")).toBe(interpolatedValue);

    // Flip back to step AND re-ripple → the stepped balance is restored.
    await store.setValuationCadenceAndRipple("mortgage", "step", { today: TODAY });
    expect(await debtsAt(store, "2026-03-20")).toBe(stepValue);
    store.close();
  });

  test("flipping a revolving debt to interpolated re-ripples between-anchor snapshots", async () => {
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
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");

    await store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 10_000_00,
        id: "an1",
        liabilityId: "card",
      },
      { today: TODAY },
    );
    await store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-03-01",
        balanceMinor: 4_000_00,
        id: "an2",
        liabilityId: "card",
      },
      { today: TODAY },
    );

    // A backdated fact BETWEEN the two anchors snapshots the portfolio there.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name: "Fondo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });
    await store.recordOperationAndRipple(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2025-02-01",
        id: "op1",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const ANCHORS = [
      { anchorDate: "2025-01-01", balanceMinor: 10_000_00 },
      { anchorDate: "2025-03-01", balanceMinor: 4_000_00 },
    ];
    const stepValue = debtBalanceAtDate({
      anchors: ANCHORS,
      currentBalanceMinor: 1_000_00,
      debtModel: "revolving",
      targetDate: "2025-02-01",
    });
    const interpolatedValue = debtBalanceAtDate({
      anchors: ANCHORS,
      cadence: "interpolated",
      currentBalanceMinor: 1_000_00,
      debtModel: "revolving",
      targetDate: "2025-02-01",
    });
    expect(interpolatedValue).not.toBe(stepValue);

    expect(await debtsAt(store, "2025-02-01")).toBe(stepValue);

    await store.setValuationCadenceAndRipple("card", "interpolated", { today: TODAY });
    expect(await debtsAt(store, "2025-02-01")).toBe(interpolatedValue);
    store.close();
  });

  test("an informal debt is unaffected by the cadence toggle (always a step)", async () => {
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
      balanceMinor: 3_000_00,
      currency: "EUR",
      id: "friend",
      name: "Amigo",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "debt",
    });
    await store.liabilities.setDebtModel("friend", "informal");
    await store.addBalanceAnchorAndRipple(
      {
        anchorDate: "2025-01-01",
        balanceMinor: 5_000_00,
        id: "an1",
        liabilityId: "friend",
      },
      { today: TODAY },
    );

    const before = await debtsAt(store, "2025-01-01");
    // Even set to interpolated, an informal balance steps — the toggle is a no-op.
    await store.setValuationCadenceAndRipple("friend", "interpolated", { today: TODAY });
    expect(await store.liabilities.readValuationCadence("friend")).toBe("interpolated");
    expect(await debtsAt(store, "2025-01-01")).toBe(before);
    store.close();
  });
});
