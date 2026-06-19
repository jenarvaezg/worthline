/**
 * Ownership scope-axis seam (ADR 0020, #239).
 *
 * An ownership-split edit re-derives history along the SCOPE axis (no new
 * snapshot dates) and must ride the SAME atomic persist+ripple seam as the
 * time-axis dated facts. These tests exercise the OWNERSHIP seam methods
 * directly at the store: one call must both persist the ownership patch AND, if
 * the split actually changed, re-weight every existing scope snapshot — atomic,
 * with the previous-ownership capture and the did-it-change comparison both
 * derived behind the seam. The real_estate branch of `updateAssetAndRipple-
 * Ownership` dispatches to the housing curve ripple instead (the valuation
 * ripple already re-weights from the asset's new split).
 */
import { allocateScopedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "@db/index";
import type { WorthlineStore } from "@db/index";

const TODAY = "2026-06-13";
const PAST_DATES = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15"];

/** A 2-member household with a 50/50 mortgage whose backdated plan backfills snapshots. */
function seed(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 20_000_00,
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
    balanceMinor: 100_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [
      { memberId: "mJ", shareBps: 5_000 },
      { memberId: "mA", shareBps: 5_000 },
    ],
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

function debtsAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): number | undefined {
  return store.snapshots.readSnapshots(scopeId).find((snap) => snap.dateKey === dateKey)
    ?.debts.amountMinor;
}

function reconciles(store: WorthlineStore, dateKey: string, scopeId: string): boolean {
  const snap = store.snapshots.readSnapshots(scopeId).find((s) => s.dateKey === dateKey);
  if (!snap) return false;
  const rows = store.snapshots.readSnapshotHoldings({
    from: dateKey,
    scopeId,
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

function owned(globalMinor: number, shareBps: number, memberId: string): number {
  return allocateScopedHolding(globalMinor, {
    ownership: [{ memberId, shareBps }],
    scopeMemberIds: new Set([memberId]),
  }).ownedMinor;
}

describe("updateLiabilityAndRippleOwnership (ownership seam, ADR 0020)", () => {
  test("one call patches the split AND re-weights every per-member snapshot; household unchanged", () => {
    const store = createInMemoryStore();
    seed(store);

    const datesBefore = store.snapshots.readSnapshots("mJ").length;

    // One atomic call: persist the 50/50 → 70/30 split and ripple the scope axis.
    store.updateLiabilityAndRippleOwnership(
      "mortgage",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
      { today: TODAY },
    );

    for (const dateKey of PAST_DATES) {
      const globalBalance = store.liabilities.debtBalanceAtDate("mortgage", dateKey)!;
      expect(debtsAt(store, dateKey, "household")).toBe(globalBalance);
      expect(debtsAt(store, dateKey, "mJ")).toBe(owned(globalBalance, 7_000, "mJ"));
      expect(debtsAt(store, dateKey, "mA")).toBe(owned(globalBalance, 3_000, "mA"));
      expect(reconciles(store, dateKey, "household")).toBe(true);
      expect(reconciles(store, dateKey, "mJ")).toBe(true);
      expect(reconciles(store, dateKey, "mA")).toBe(true);
    }

    // No new snapshot dates were created by the ownership edit.
    expect(store.snapshots.readSnapshots("mJ").length).toBe(datesBefore);
    store.close();
  });

  test("a cosmetic edit (same split) persists the patch but ripples nothing", () => {
    const store = createInMemoryStore();
    seed(store);

    const before = PAST_DATES.map((d) => debtsAt(store, d, "mJ"));

    // Rename only — the split is unchanged, so the seam must NOT ripple.
    store.updateLiabilityAndRippleOwnership(
      "mortgage",
      {
        name: "Hipoteca renombrada",
        ownership: [
          { memberId: "mJ", shareBps: 5_000 },
          { memberId: "mA", shareBps: 5_000 },
        ],
      },
      { today: TODAY },
    );

    expect(
      store.liabilities.readLiabilities().find((l) => l.id === "mortgage")?.name,
    ).toBe("Hipoteca renombrada");
    const after = PAST_DATES.map((d) => debtsAt(store, d, "mJ"));
    expect(after).toEqual(before);
    store.close();
  });
});

/**
 * The home global value (cents) chosen so the household's 65% combined share
 * cannot be divided back to GLOBAL losslessly — the exact ±1 the lossy "divide
 * the rounded household row" recovery introduced (#187).
 */
const HOME_GLOBAL_MINOR = 30_000_001;

/** A 2-member household owning a home co-owned 65% by the household (35% a non-member). */
function seedCoOwnedHome(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 20_000_00,
    id: "cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [
      { memberId: "mJ", shareBps: 5_000 },
      { memberId: "mA", shareBps: 5_000 },
    ],
    type: "cash",
  });
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: HOME_GLOBAL_MINOR,
    id: "piso",
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: [
      { memberId: "mJ", shareBps: 4_000 },
      { memberId: "mA", shareBps: 2_500 },
    ],
    type: "real_estate",
  });
  store.addValuationAnchorAndRipple(
    {
      adjustsPriorCurve: true,
      assetId: "piso",
      id: "anchor1",
      valuationDate: "2026-01-15",
      valueMinor: HOME_GLOBAL_MINOR,
    },
    { today: TODAY },
  );
  store.liabilities.createLiability({
    balanceMinor: 200_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [
      { memberId: "mJ", shareBps: 4_000 },
      { memberId: "mA", shareBps: 2_500 },
    ],
    type: "mortgage",
  });
  store.liabilities.setDebtModel("mortgage", "amortizable");
  store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: "0.0317",
      id: "plan1",
      initialCapitalMinor: 210_000_00,
      liabilityId: "mortgage",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      termMonths: 240,
    },
    { today: TODAY },
  );
}

function homeRowAt(
  store: WorthlineStore,
  dateKey: string,
  scopeId: string,
): number | undefined {
  return store.snapshots
    .readSnapshotHoldings({ from: dateKey, scopeId, to: dateKey })
    .find((r) => r.holdingId === "piso")?.valueMinor;
}

describe("updateAssetAndRippleOwnership for a real_estate holding (ADR 0020)", () => {
  test("a real_estate ownership edit re-weights each member's home row losslessly via the curve ripple", () => {
    const store = createInMemoryStore();
    seedCoOwnedHome(store);

    const dates = store.snapshots.readSnapshots("household").map((snap) => snap.dateKey);
    expect(dates.length).toBeGreaterThan(2);

    // Correct the INTERNAL member split (40/25 → 30/35); household stays 65%.
    store.updateAssetAndRippleOwnership(
      "piso",
      {
        ownership: [
          { memberId: "mJ", shareBps: 3_000 },
          { memberId: "mA", shareBps: 3_500 },
        ],
      },
      { today: TODAY },
    );

    for (const dateKey of dates) {
      expect(homeRowAt(store, dateKey, "household")).toBe(
        owned(HOME_GLOBAL_MINOR, 6_500, "mJ"),
      );
      expect(homeRowAt(store, dateKey, "mJ")).toBe(owned(HOME_GLOBAL_MINOR, 3_000, "mJ"));
      expect(homeRowAt(store, dateKey, "mA")).toBe(owned(HOME_GLOBAL_MINOR, 3_500, "mA"));
      expect(reconciles(store, dateKey, "household")).toBe(true);
      expect(reconciles(store, dateKey, "mJ")).toBe(true);
      expect(reconciles(store, dateKey, "mA")).toBe(true);
    }

    store.close();
  });
});

describe("updateAssetAndRippleOwnership for a non-real_estate holding (ADR 0020)", () => {
  test("re-weights a co-owned fund's member rows from the new split", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [
        { id: "mJ", name: "Jose" },
        { id: "mA", name: "Ana" },
      ],
      mode: "household",
    });
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fondo",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [
        { memberId: "mJ", shareBps: 6_000 },
        { memberId: "mA", shareBps: 4_000 },
      ],
    });
    store.recordOperationAndRipple(
      {
        assetId: "fondo",
        currency: "EUR",
        executedAt: "2026-01-01",
        feesMinor: 0,
        id: "opBuy",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );
    store.liabilities.createLiability({
      balanceMinor: 200_000_00,
      currency: "EUR",
      id: "mortgage",
      name: "Hipoteca",
      ownership: [
        { memberId: "mJ", shareBps: 6_000 },
        { memberId: "mA", shareBps: 4_000 },
      ],
      type: "mortgage",
    });
    store.liabilities.setDebtModel("mortgage", "amortizable");
    store.createAmortizationPlanAndRipple(
      {
        annualInterestRate: "0.0317",
        id: "plan1",
        initialCapitalMinor: 210_000_00,
        liabilityId: "mortgage",
        disbursementDate: "2026-01-15",
        firstPaymentDate: "2026-02-15",
        termMonths: 240,
      },
      { today: TODAY },
    );

    const fundRow = (dateKey: string, scopeId: string): number | undefined =>
      store.snapshots
        .readSnapshotHoldings({ from: dateKey, scopeId, to: dateKey })
        .find((r) => r.holdingId === "fondo")?.valueMinor;

    const dates = store.snapshots.readSnapshots("household").map((snap) => snap.dateKey);
    expect(dates.length).toBeGreaterThan(0);
    const globalCost = 10 * 100_00; // cost basis, #183

    store.updateAssetAndRippleOwnership(
      "fondo",
      {
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
      { today: TODAY },
    );

    for (const dateKey of dates) {
      expect(fundRow(dateKey, "household")).toBe(globalCost);
      expect(fundRow(dateKey, "mJ")).toBe(owned(globalCost, 7_000, "mJ"));
      expect(fundRow(dateKey, "mA")).toBe(owned(globalCost, 3_000, "mA"));
    }
    store.close();
  });
});
