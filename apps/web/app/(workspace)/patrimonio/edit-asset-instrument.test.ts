/**
 * Correcting a holding's instrument from its ficha (#1512, ADR 0098).
 *
 * A public pension filed as an `property` weighs like brick: housing rung, the
 * housing tier's guessed 3 % real return, and the IMMOBILIZED side of the FIRE
 * capital split. The instrument used to be pickable only at the alta, so the only
 * exit was to delete the holding and re-create it — losing its history, its
 * declared payouts and its ledger.
 *
 * These tests drive `editAssetAction` against a real in-memory store and assert
 * the two halves of the fix: the classification moves (the FIRE capital side is
 * measured with the real domain functions, before and after), and NOTHING else
 * does — not the declared value, not the rung, not the payouts.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import {
  assembleFireEligiblePool,
  effectiveRealReturn,
  instrumentOfAsset,
  splitFireCapital,
  tierOfAsset,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { editAssetAction } from "./actions";

const OWN = [{ memberId: "mJ", shareBps: 10_000 }];

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

/**
 * A pension declared «a plazo» but filed as an inmueble — Jorge's row. The rung it
 * DECLARES is sellable; the instrument overrides it onto `housing` (`tierOfAsset`),
 * which is what drags it to the immobilized side.
 */
async function seedMisfiledPension(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jorge" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 45_000_00,
    id: "pension",
    liquidityTier: "term-locked",
    name: "Pensión Pública Seguridad Social Española",
    ownership: OWN,
    type: "real_estate",
  });
  return store;
}

/** This scope's FIRE pool, assembled the way `/objetivos` assembles it. */
async function firePool(store: WorthlineStore) {
  const workspace = (await store.workspace.readWorkspace())!;
  return assembleFireEligiblePool({
    assets: await store.assets.readAssets(),
    config: { excludedAssetIds: [] },
    liabilities: await store.liabilities.readLiabilities(),
    scopeId: "mJ",
    workspace,
  });
}

/** Which side of the FIRE capital split this scope's capital lands on, per side. */
async function fireSides(
  store: WorthlineStore,
): Promise<{ immobilized: number; sellable: number }> {
  const pool = await firePool(store);
  const split = splitFireCapital({
    debtByTierMinor: pool.scopedDebtByTierMinor,
    eligibleByTierMinor: pool.eligibleByTierMinor,
  });
  return {
    immobilized: split.immobilized.amountMinor,
    sellable: split.sellable.amountMinor,
  };
}

/** The weighted real return the scope's pool implies — the «retorno» on screen. */
async function fireRealReturn(store: WorthlineStore): Promise<number> {
  const pool = await firePool(store);
  return effectiveRealReturn({ eligibleByTierMinor: pool.eligibleByTierMinor });
}

function correction(instrument: string): FormData {
  return form({
    id: "pension",
    instrument,
    liquidityTier: "term-locked",
    name: "Pensión Pública Seguridad Social Española",
    ownershipPreset: "custom",
    owner_mJ: "100",
  });
}

describe("editAssetAction — correcting the instrument (#1512)", () => {
  test("a misfiled property crosses from the immobilized side to the sellable one", async () => {
    const store = await seedMisfiledPension();

    const before = await fireSides(store);
    expect(before.immobilized).toBe(45_000_00);
    expect(before.sellable).toBe(0);

    await runAction(correction("term_deposit"), store);

    const asset = (await store.assets.readAssets()).find((a) => a.id === "pension")!;
    expect(instrumentOfAsset(asset)).toBe("term_deposit");
    expect(tierOfAsset(asset)).toBe("term-locked");

    const after = await fireSides(store);
    expect(after.sellable).toBe(45_000_00);
    expect(after.immobilized).toBe(0);
  });

  test("the supposed real return stops being the housing tier's 3 %", async () => {
    const store = await seedMisfiledPension();

    // Filed as brick, the pension was being priced at the housing tier's guessed
    // 3 % (`TIER_REAL_RETURN_DEFAULTS.housing`) — the whole pool here, so the
    // weighted return IS that rate.
    expect(await fireRealReturn(store)).toBeCloseTo(0.03, 10);

    await runAction(correction("term_deposit"), store);

    // Corrected, it falls back to the rung it actually declares: `term-locked`.
    expect(await fireRealReturn(store)).toBeCloseTo(0.015, 10);
  });

  test("promoting a holding to inmueble sends it back to the immobilized side", async () => {
    const store = await seedMisfiledPension();
    await runAction(correction("term_deposit"), store);

    await runAction(correction("property"), store);

    const asset = (await store.assets.readAssets()).find((a) => a.id === "pension")!;
    expect(instrumentOfAsset(asset)).toBe("property");
    expect(tierOfAsset(asset)).toBe("housing");
    expect((await fireSides(store)).immobilized).toBe(45_000_00);
  });

  test("the correction touches neither the declared value nor the declared rung", async () => {
    const store = await seedMisfiledPension();

    await runAction(correction("other"), store);

    const asset = (await store.assets.readAssets()).find((a) => a.id === "pension")!;
    expect(asset.currentValue.amountMinor).toBe(45_000_00);
    // The rung the user DECLARED survives: `defaultsFor("other").rung` is
    // `illiquid`, and re-applying it here would silently re-immobilize the row.
    expect(asset.liquidityTier).toBe("term-locked");
  });

  test("the declared payouts survive the correction", async () => {
    const store = await seedMisfiledPension();
    await store.payouts.createPayoutSchedule({
      amountMinor: 1_200_00,
      cadence: "monthly",
      holdingId: "pension",
      label: "Pensión mensual",
      startISO: "2026-01-01",
    });

    await runAction(correction("other"), store);

    const schedules = await store.payouts.readPayoutSchedulesForHolding("pension");
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.amountMinor).toBe(1_200_00);
  });

  test("an instrument outside the holding's persistence shape is refused", async () => {
    const store = await seedMisfiledPension();

    // `pension_plan` is `derived` — units × price over an operations ledger this
    // hand-valued row has never had. Offering it would promise a valuation the
    // store cannot produce, so the seam refuses instead of writing the column.
    const url = await runAction(correction("pension_plan"), store);

    expect(url).toContain("error");
    const asset = (await store.assets.readAssets()).find((a) => a.id === "pension")!;
    expect(instrumentOfAsset(asset)).toBe("property");
  });

  describe("the known-partial ownership guard judges the SUBMITTED split", () => {
    async function seedSharedFlat(shareBps: number): Promise<WorthlineStore> {
      const store = await createInMemoryStore();
      await store.workspace.initializeWorkspace({
        members: [{ id: "mJ", name: "Jorge" }],
        mode: "individual",
      });
      await store.assets.createManualAsset({
        currency: "EUR",
        currentValueMinor: 30_000_000,
        id: "piso",
        liquidityTier: "illiquid",
        name: "Piso compartido",
        ownership: [{ memberId: "mJ", shareBps: shareBps }],
        type: "real_estate",
      });
      return store;
    }

    function flatCorrection(ownerPct: string): FormData {
      return form({
        id: "piso",
        instrument: "other",
        liquidityTier: "illiquid",
        name: "Piso compartido",
        ownershipPreset: "custom",
        owner_mJ: ownerPct,
      });
    }

    test("refuses a partial that would be completed to full ownership", async () => {
      // 75 % declared — the other 25 % belongs to a non-member (#171).
      const store = await seedSharedFlat(7_500);

      const url = await runAction(flatCorrection("75"), store);

      expect(url).toContain("error");
      const asset = (await store.assets.readAssets()).find((a) => a.id === "piso")!;
      expect(instrumentOfAsset(asset)).toBe("property");
      // The 25 % that is not the user's was NOT handed to them by the refusal.
      expect(asset.ownership).toEqual([{ memberId: "mJ", shareBps: 7_500 }]);
    });

    test("refuses a partial arriving in THIS submit, over a fully-owned row", async () => {
      // The row is 100 % his; the FORM declares 75 %. Judging the stored split
      // would wave this through and `completeShortfall` would hand the 25 % back
      // — the change of net worth the guard exists to stop.
      const store = await seedSharedFlat(10_000);

      const url = await runAction(flatCorrection("75"), store);

      expect(url).toContain("error");
      const asset = (await store.assets.readAssets()).find((a) => a.id === "piso")!;
      expect(instrumentOfAsset(asset)).toBe("property");
      expect(asset.ownership).toEqual([{ memberId: "mJ", shareBps: 10_000 }]);
    });

    test("accepts the submit that fixes the titularidad AND the instrument at once", async () => {
      const store = await seedSharedFlat(7_500);

      await runAction(flatCorrection("100"), store);

      const asset = (await store.assets.readAssets()).find((a) => a.id === "piso")!;
      expect(instrumentOfAsset(asset)).toBe("other");
      expect(asset.ownership).toEqual([{ memberId: "mJ", shareBps: 10_000 }]);
    });

    test("keeps a partial split when the correction stays on property", async () => {
      const store = await seedSharedFlat(7_500);

      await runAction(
        form({
          id: "piso",
          instrument: "property",
          liquidityTier: "illiquid",
          name: "Piso compartido",
          ownershipPreset: "custom",
          owner_mJ: "75",
        }),
        store,
      );

      const asset = (await store.assets.readAssets()).find((a) => a.id === "piso")!;
      expect(asset.ownership).toEqual([{ memberId: "mJ", shareBps: 7_500 }]);
    });
  });

  test("correcting away from inmueble drops the primary-residence flag with it", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "mJ", name: "Jorge" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "casa",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Casa",
      ownership: OWN,
      type: "real_estate",
    });

    await runAction(
      form({
        id: "casa",
        instrument: "vehicle",
        liquidityTier: "illiquid",
        name: "Casa",
        ownershipPreset: "custom",
        owner_mJ: "100",
      }),
      store,
    );

    const asset = (await store.assets.readAssets()).find((a) => a.id === "casa")!;
    expect(asset.isPrimaryResidence).toBe(false);
    expect(instrumentOfAsset(asset)).toBe("vehicle");
  });
});
