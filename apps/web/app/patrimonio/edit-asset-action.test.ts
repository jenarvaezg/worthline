/**
 * editAssetAction ownership-split ripple wiring (#172).
 *
 * Editing a liability's ownership split is a retroactive parameter change that
 * ripples per-member snapshot history (ADR 0012); a cosmetic edit (a rename,
 * same split) does NOT ripple — the frozen-snapshot invariant holds for those.
 * These tests drive the action against a real in-memory store seeded with a
 * backdated mortgage whose amortization plan backfilled monthly snapshots.
 */
import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { allocateScopedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { editAssetAction } from "./actions";

const TODAY = "2026-06-13";
const A_DATE = "2026-03-15";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

async function runAction(fd: FormData, store: WorthlineStore): Promise<string> {
  try {
    await editAssetAction(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

function seed(store: WorthlineStore): void {
  store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
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

function debtsAt(store: WorthlineStore, scopeId: string): number | undefined {
  return store.snapshots.readSnapshots(scopeId).find((snap) => snap.dateKey === A_DATE)
    ?.debts.amountMinor;
}

describe("editAssetAction — ownership-split ripple (#172)", () => {
  test("editing a liability's ownership split ripples its member-scope history", () => {
    const store = createInMemoryStore();
    seed(store);

    const before = debtsAt(store, "mJ")!;

    return runAction(
      form({
        id: "mortgage",
        isLiability: "true",
        name: "Hipoteca",
        type: "mortgage",
        ownershipPreset: "custom",
        owner_mJ: "70",
        owner_mA: "30",
      }),
      store,
    ).then(() => {
      const global = store.liabilities.debtBalanceAtDate("mortgage", A_DATE)!;
      const expectedJose = allocateScopedHolding(global, {
        ownership: [{ memberId: "mJ", shareBps: 7_000 }],
        scopeMemberIds: new Set(["mJ"]),
      }).ownedMinor;
      // Jose's frozen share moved from 50% to 70% of the global balance.
      expect(debtsAt(store, "mJ")).toBeGreaterThan(before);
      expect(debtsAt(store, "mJ")).toBe(expectedJose);
      // Household keeps the full balance (a 100% scope is invariant).
      expect(debtsAt(store, "household")).toBe(global);
    });
  });

  test("editing a debt on a co-owned home to a partial split is accepted and re-weights history", () => {
    const store = createInMemoryStore();
    store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    // A home co-owned with a non-member (75% Jose), and its mortgage — initially
    // recorded at 100% — being corrected to mirror the home's 75% (#171/#172).
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 7_500 }],
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

    return runAction(
      form({
        id: "mortgage",
        isLiability: "true",
        name: "Hipoteca",
        type: "mortgage",
        associatedAssetId: "piso",
        ownershipPreset: "custom",
        owner_mJ: "75",
      }),
      store,
    ).then(() => {
      // Accepted as a known partial (not rejected as "must sum to 100%").
      expect(store.liabilities.readLiabilities()[0]!.ownership).toEqual([
        { memberId: "mJ", shareBps: 7_500 },
      ]);
      const curve = store.liabilities.debtBalanceAtDate("mortgage", A_DATE)!;
      const expected = allocateScopedHolding(curve, {
        ownership: [{ memberId: "mJ", shareBps: 7_500 }],
        scopeMemberIds: new Set(["mJ"]),
      }).ownedMinor;
      // History re-weighted to 75% of the curve balance — both member and household.
      expect(debtsAt(store, "mJ")).toBe(expected);
      expect(debtsAt(store, "household")).toBe(expected);
    });
  });

  test("a rename (same ownership split) does NOT ripple history", () => {
    const store = createInMemoryStore();
    seed(store);

    const before = {
      household: debtsAt(store, "household"),
      mA: debtsAt(store, "mA"),
      mJ: debtsAt(store, "mJ"),
    };

    return runAction(
      form({
        id: "mortgage",
        isLiability: "true",
        name: "Hipoteca renombrada",
        type: "mortgage",
        // Even split for 2 members === the current 50/50 → no ownership change.
        ownershipPreset: "even",
      }),
      store,
    ).then(() => {
      expect(store.liabilities.readLiabilities()[0]!.name).toBe("Hipoteca renombrada");
      // History is untouched by the cosmetic edit.
      expect(debtsAt(store, "mJ")).toBe(before.mJ);
      expect(debtsAt(store, "mA")).toBe(before.mA);
      expect(debtsAt(store, "household")).toBe(before.household);
    });
  });
});
