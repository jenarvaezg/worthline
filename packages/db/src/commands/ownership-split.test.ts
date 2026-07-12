/**
 * Ownership-split commands (#968): validate totals in the command layer and
 * route persist + scope-axis ripple through the store seam — no server actions.
 */

import { createInMemoryStore } from "@db/index";
import { allocateScopedHolding } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  executeUpdateAssetOwnershipSplitCommand,
  executeUpdateLiabilityOwnershipSplitCommand,
} from "./index";

const TODAY = "2026-06-13";

async function seedHouseholdMortgage() {
  const store = await createInMemoryStore();
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
  return store;
}

async function debtsAt(
  store: Awaited<ReturnType<typeof seedHouseholdMortgage>>,
  dateKey: string,
  scopeId: string,
): Promise<number | undefined> {
  return (await store.snapshots.readSnapshots(scopeId)).find(
    (snap) => snap.dateKey === dateKey,
  )?.debts.amountMinor;
}

function owned(globalMinor: number, shareBps: number, memberId: string): number {
  return allocateScopedHolding(globalMinor, {
    ownership: [{ memberId, shareBps }],
    scopeMemberIds: new Set([memberId]),
  }).ownedMinor;
}

describe("ownership-split commands", () => {
  test("liability command rejects a split that does not total 100%", async () => {
    const store = await seedHouseholdMortgage();

    const result = await executeUpdateLiabilityOwnershipSplitCommand(store, {
      liabilityId: "mortgage",
      patch: {
        name: "Hipoteca",
        ownership: [
          { memberId: "mJ", shareBps: 4_000 },
          { memberId: "mA", shareBps: 4_000 },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      violation: { code: "ownership_split_invalid", totalBps: 8_000 },
    });
    store.close();
  });

  test("liability command patches split and re-weights per-member snapshots", async () => {
    const store = await seedHouseholdMortgage();
    const dateKey = "2026-03-15";
    const householdBefore = await debtsAt(store, dateKey, "household");
    const datesBefore = (await store.snapshots.readSnapshots("mJ")).length;

    const result = await executeUpdateLiabilityOwnershipSplitCommand(store, {
      liabilityId: "mortgage",
      patch: {
        name: "Hipoteca",
        ownership: [
          { memberId: "mJ", shareBps: 7_000 },
          { memberId: "mA", shareBps: 3_000 },
        ],
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await debtsAt(store, dateKey, "household")).toBe(householdBefore);
    expect((await store.snapshots.readSnapshots("mJ")).length).toBe(datesBefore);
    expect(await debtsAt(store, dateKey, "mJ")).toBe(
      owned(householdBefore!, 7_000, "mJ"),
    );
    expect(await debtsAt(store, dateKey, "mA")).toBe(
      owned(householdBefore!, 3_000, "mA"),
    );
    store.close();
  });

  test("asset command accepts a known partial split on real_estate", async () => {
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
      ownership: [{ memberId: "mJ", shareBps: 7_500 }],
      type: "real_estate",
    });

    const result = await executeUpdateAssetOwnershipSplitCommand(store, {
      assetId: "piso",
      today: TODAY,
      allowKnownPartial: true,
      patch: {
        name: "Piso",
        type: "real_estate",
        ownership: [{ memberId: "mJ", shareBps: 6_000 }],
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    store.close();
  });

  test("asset command rejects an over-100% split", async () => {
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

    const result = await executeUpdateAssetOwnershipSplitCommand(store, {
      assetId: "cash",
      patch: {
        name: "Cuenta",
        ownership: [
          { memberId: "mJ", shareBps: 6_000 },
          { memberId: "mA", shareBps: 6_000 },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      violation: { code: "ownership_split_invalid", totalBps: 12_000 },
    });
    store.close();
  });
});
