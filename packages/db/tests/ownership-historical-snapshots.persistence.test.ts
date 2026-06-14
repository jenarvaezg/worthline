/**
 * Historical snapshots re-weighting after an ownership-split edit (#172).
 *
 * An ownership split determines how each frozen snapshot weights a holding's
 * global value into each member's scope. Correcting it is a retroactive
 * parameter change (ADR 0012), so it must ripple: every existing per-member
 * scope snapshot is re-derived with the new weighting, the household scope (which
 * always sums to 100%) is untouched, no new snapshot dates are created, and the
 * reconciliation invariant (ADR 0008) still holds. The concrete scenario: a user
 * backdates a mortgage (which backfills monthly snapshots, PRD #109), then later
 * corrects the ownership %.
 */
import { allocateScopedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { createInMemoryStore } from "../src/index";
import type { WorthlineStore } from "../src/index";

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
  store.liabilities.createAmortizationPlan({
    annualInterestRate: "0.03",
    id: "plan1",
    initialCapitalMinor: 150_000_00,
    liabilityId: "mortgage",
    startDate: "2026-01-15",
    termMonths: 240,
  });
  store.rippleHistoricalSnapshotsForDebt({
    kind: "amortizable-plan",
    liabilityId: "mortgage",
    today: TODAY,
  });
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

describe("ownership-split ripple over historical snapshots (#172)", () => {
  test("re-weights every per-member snapshot to the new split; household unchanged; no new dates", () => {
    const store = createInMemoryStore();
    seed(store);

    const datesBefore = store.snapshots.readSnapshots("mJ").length;

    // Correct the mortgage split from 50/50 to 70/30 and ripple.
    store.liabilities.updateLiability("mortgage", {
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });
    store.rippleHistoricalSnapshotsForOwnership({
      holdingId: "mortgage",
      kind: "liability",
      previousOwnership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
    });

    for (const dateKey of PAST_DATES) {
      const globalBalance = store.liabilities.debtBalanceAtDate("mortgage", dateKey)!;
      // Household always sees the full balance — the edit does not touch it.
      expect(debtsAt(store, dateKey, "household")).toBe(globalBalance);
      // Each member's scope is re-weighted by the new split.
      expect(debtsAt(store, dateKey, "mJ")).toBe(owned(globalBalance, 7_000, "mJ"));
      expect(debtsAt(store, dateKey, "mA")).toBe(owned(globalBalance, 3_000, "mA"));
      // Reconciliation holds for every scope.
      expect(reconciles(store, dateKey, "household")).toBe(true);
      expect(reconciles(store, dateKey, "mJ")).toBe(true);
      expect(reconciles(store, dateKey, "mA")).toBe(true);
    }

    // No new snapshot dates were created by the ownership edit.
    expect(store.snapshots.readSnapshots("mJ").length).toBe(datesBefore);
    store.close();
  });

  test("re-running the ripple is idempotent (stable under repeated edits)", () => {
    const store = createInMemoryStore();
    seed(store);

    store.liabilities.updateLiability("mortgage", {
      ownership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });
    store.rippleHistoricalSnapshotsForOwnership({
      holdingId: "mortgage",
      kind: "liability",
      previousOwnership: [
        { memberId: "mJ", shareBps: 5_000 },
        { memberId: "mA", shareBps: 5_000 },
      ],
    });
    const first = PAST_DATES.map((d) => debtsAt(store, d, "mJ"));

    // Re-running with the now-current split must be a no-op (rows already 70/30).
    store.rippleHistoricalSnapshotsForOwnership({
      holdingId: "mortgage",
      kind: "liability",
      previousOwnership: [
        { memberId: "mJ", shareBps: 7_000 },
        { memberId: "mA", shareBps: 3_000 },
      ],
    });
    const second = PAST_DATES.map((d) => debtsAt(store, d, "mJ"));

    expect(second).toEqual(first);
    store.close();
  });
});
