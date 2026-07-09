/**
 * editAssetAction ownership-split ripple wiring (#172).
 *
 * Editing a liability's ownership split is a retroactive parameter change that
 * ripples per-member snapshot history (ADR 0012); a cosmetic edit (a rename,
 * same split) does NOT ripple — the frozen-snapshot invariant holds for those.
 * These tests drive the action against a real in-memory store seeded with a
 * backdated mortgage whose amortization plan backfilled monthly snapshots.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
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

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "mJ", name: "Jose" },
      { id: "mA", name: "Ana" },
    ],
    mode: "household",
  });
  await store.liabilities.createLiability({
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
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.createAmortizationPlanAndRipple(
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

async function debtsAt(
  store: WorthlineStore,
  scopeId: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === A_DATE,
  )?.debts.amountMinor;
}

describe("editAssetAction — ownership-split ripple (#172)", () => {
  test("editing a liability's ownership split ripples its member-scope history", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const before = (await debtsAt(store, "mJ"))!;

    await runAction(
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
    );
    const global = (await store.liabilities.debtBalanceAtDate("mortgage", A_DATE))!;
    const expectedJose = allocateScopedHolding(global, {
      ownership: [{ memberId: "mJ", shareBps: 7_000 }],
      scopeMemberIds: new Set(["mJ"]),
    }).ownedMinor;
    // Jose's frozen share moved from 50% to 70% of the global balance.
    expect(await debtsAt(store, "mJ")).toBeGreaterThan(before);
    expect(await debtsAt(store, "mJ")).toBe(expectedJose);
    // Household keeps the full balance (a 100% scope is invariant).
    expect(await debtsAt(store, "household")).toBe(global);
  });

  test("editing a debt on a co-owned home to a partial split is accepted and re-weights history", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    // A home co-owned with a non-member (75% Jose), and its mortgage — initially
    // recorded at 100% — being corrected to mirror the home's 75% (#171/#172).
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 7_500 }],
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
    await store.createAmortizationPlanAndRipple(
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

    await runAction(
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
    );
    // Accepted as a known partial (not rejected as "must sum to 100%").
    expect((await store.liabilities.readLiabilities())[0]!.ownership).toEqual([
      { memberId: "mJ", shareBps: 7_500 },
    ]);
    const curve = (await store.liabilities.debtBalanceAtDate("mortgage", A_DATE))!;
    const expected = allocateScopedHolding(curve, {
      ownership: [{ memberId: "mJ", shareBps: 7_500 }],
      scopeMemberIds: new Set(["mJ"]),
    }).ownedMinor;
    // History re-weighted to 75% of the curve balance. Individual mode has a
    // single scope — the household, which is the lone person (#269).
    expect(await debtsAt(store, "household")).toBe(expected);
  });

  test("a rename (same ownership split) does NOT ripple history", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    const before = {
      household: await debtsAt(store, "household"),
      mA: await debtsAt(store, "mA"),
      mJ: await debtsAt(store, "mJ"),
    };

    await runAction(
      form({
        id: "mortgage",
        isLiability: "true",
        name: "Hipoteca renombrada",
        type: "mortgage",
        // Even split for 2 members === the current 50/50 → no ownership change.
        ownershipPreset: "even",
      }),
      store,
    );
    expect((await store.liabilities.readLiabilities())[0]!.name).toBe(
      "Hipoteca renombrada",
    );
    // History is untouched by the cosmetic edit.
    expect(await debtsAt(store, "mJ")).toBe(before.mJ);
    expect(await debtsAt(store, "mA")).toBe(before.mA);
    expect(await debtsAt(store, "household")).toBe(before.household);
  });
});

describe("editAssetAction — single primary residence", () => {
  async function seedTwoHomes(): Promise<WorthlineStore> {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "casa",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Casa",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 20_000_000,
      id: "piso",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });
    return store;
  }

  test("marking a second asset as primary residence is rejected naming the current one", async () => {
    const store = await seedTwoHomes();

    const url = await runAction(
      form({
        id: "piso",
        name: "Piso",
        type: "real_estate",
        liquidityTier: "illiquid",
        isPrimaryResidence: "on",
        ownershipPreset: "custom",
        owner_mJ: "100",
      }),
      store,
    );

    expect(url).toContain("vivienda+habitual");
    expect(
      (await store.assets.readAssets()).find((a) => a.id === "piso")!.isPrimaryResidence,
    ).toBe(false);
  });

  test("re-affirming the current primary residence on itself still saves", async () => {
    const store = await seedTwoHomes();

    const url = await runAction(
      form({
        id: "casa",
        name: "Casa renombrada",
        type: "real_estate",
        liquidityTier: "illiquid",
        isPrimaryResidence: "on",
        ownershipPreset: "custom",
        owner_mJ: "100",
      }),
      store,
    );

    expect(url).toContain("saved");
    const casa = (await store.assets.readAssets()).find((a) => a.id === "casa")!;
    expect(casa.name).toBe("Casa renombrada");
    expect(casa.isPrimaryResidence).toBe(true);
  });

  test("editing a housing-rung property preserves its liquidity tier", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "casa",
      liquidityTier: "housing",
      name: "Casa",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
      type: "real_estate",
    });

    const url = await runAction(
      form({
        id: "casa",
        name: "Casa",
        type: "real_estate",
        liquidityTier: "housing",
        ownershipPreset: "scope",
        scopeMemberId: "mJ",
      }),
      store,
    );

    expect(url).toContain("saved");
    expect((await store.assets.readAssets())[0]!.liquidityTier).toBe("housing");
  });
});
