/**
 * Editing an asset's type / primary-residence flag must keep its `instrument`
 * column in sync (#149). Housing-ness is now sourced from `instrument` (which the
 * stored column drives), so an edit that does not re-derive the instrument would
 * silently diverge from the old type-based rule — the S2-class byte-identity trap.
 */

import { createInMemoryStore } from "@db/testing";
import { isHousingAsset } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const own = [{ memberId: "m1", shareBps: 10000 }];

async function freshStore() {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Alice" }],
    mode: "individual",
  });
  return store;
}

describe("editing an asset keeps instrument + housing-ness in sync (#149)", () => {
  test("toggling primary residence on a manual asset reclassifies it as housing", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 250000,
      id: "a1",
      liquidityTier: "illiquid",
      name: "Casa de campo",
      ownership: own,
      type: "manual",
    });

    const before = (await store.assets.readAssets()).find((a) => a.id === "a1")!;
    expect(before.instrument).toBe("other");
    expect(isHousingAsset(before)).toBe(false);

    // Only isPrimaryResidence changes — the instrument must re-derive from the
    // EFFECTIVE (current type "manual" + new primary-residence true) → property.
    await store.assets.updateAsset("a1", { isPrimaryResidence: true });

    const after = (await store.assets.readAssets()).find((a) => a.id === "a1")!;
    expect(after.instrument).toBe("property");
    expect(isHousingAsset(after)).toBe(true);
    store.close();
  });

  test("demoting a real_estate asset to a plain manual asset drops it from housing", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300000,
      id: "a2",
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: own,
      type: "real_estate",
    });

    const before = (await store.assets.readAssets()).find((a) => a.id === "a2")!;
    expect(before.instrument).toBe("property");
    expect(isHousingAsset(before)).toBe(true);

    await store.assets.updateAsset("a2", { isPrimaryResidence: false, type: "manual" });

    const after = (await store.assets.readAssets()).find((a) => a.id === "a2")!;
    expect(after.instrument).toBe("other");
    expect(isHousingAsset(after)).toBe(false);
    store.close();
  });
});

/**
 * #1512: the instrument is no longer a write-once alta choice. A holding filed
 * under the wrong instrument (a public pension as `property`) can be corrected by
 * name, and the correction touches the classification and nothing else — not the
 * declared value, not the price configuration, not the payouts.
 */
describe("correcting an asset's instrument by name (#1512)", () => {
  test("an explicit instrument wins over the type-derived one and re-derives the type", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 4500000,
      id: "a3",
      liquidityTier: "illiquid",
      name: "Pensión Pública Seguridad Social",
      ownership: own,
      type: "real_estate",
    });

    await store.assets.updateAsset("a3", { instrument: "term_deposit" });

    const after = (await store.assets.readAssets()).find((a) => a.id === "a3")!;
    expect(after.instrument).toBe("term_deposit");
    // The legacy AssetType follows the instrument, never the other way round.
    expect(after.type).toBe("manual");
    expect(isHousingAsset(after)).toBe(false);
    store.close();
  });

  test("the declared value survives the correction untouched", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 4500000,
      id: "a4",
      liquidityTier: "illiquid",
      name: "Pensión Pública",
      ownership: own,
      type: "real_estate",
    });

    await store.assets.updateAsset("a4", { instrument: "other" });

    const after = (await store.assets.readAssets()).find((a) => a.id === "a4")!;
    expect(after.currentValue.amountMinor).toBe(4500000);
    expect(after.liquidityTier).toBe("illiquid");
    store.close();
  });

  test("promoting a plain asset to property puts it back on housing", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30000000,
      id: "a5",
      liquidityTier: "illiquid",
      name: "Piso de Plasencia",
      ownership: own,
      type: "manual",
    });

    await store.assets.updateAsset("a5", { instrument: "property" });

    const after = (await store.assets.readAssets()).find((a) => a.id === "a5")!;
    expect(after.instrument).toBe("property");
    expect(after.type).toBe("real_estate");
    expect(isHousingAsset(after)).toBe(true);
    store.close();
  });

  test("correcting away from property clears the primary-residence flag", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30000000,
      id: "a6",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Mi casa",
      ownership: own,
      type: "real_estate",
    });

    await store.assets.updateAsset("a6", { instrument: "vehicle" });

    const after = (await store.assets.readAssets()).find((a) => a.id === "a6")!;
    // A vehicle cannot be anybody's habitual residence: leaving the flag set
    // would let the next type edit resurrect `property` and undo the fix.
    expect(after.isPrimaryResidence).toBe(false);
    expect(after.instrument).toBe("vehicle");
    store.close();
  });

  test("the investment ficha's own save writes the instrument and keeps the symbol", async () => {
    const store = await freshStore();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "i2",
      instrument: "fund",
      name: "Plan de pensiones de Jorge",
      ownership: own,
      priceProvider: "finect",
      providerSymbol: "N5138",
    });

    await store.assets.updateInvestmentAsset({
      id: "i2",
      instrument: "pension_plan",
      name: "Plan de pensiones de Jorge",
      priceProvider: "finect",
      providerSymbol: "N5138",
    });

    const after = (await store.assets.readAssets()).find((a) => a.id === "i2")!;
    expect(after.instrument).toBe("pension_plan");
    const investment = await store.assets.readInvestmentAssetById("i2");
    expect(investment?.priceProvider).toBe("finect");
    expect(investment?.providerSymbol).toBe("N5138");
    store.close();
  });

  test("an investment correction leaves its price configuration alone", async () => {
    const store = await freshStore();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "i1",
      instrument: "fund",
      name: "Plan de pensiones de Jorge",
      ownership: own,
      priceProvider: "yahoo",
      providerSymbol: "SXR1.DE",
    });

    await store.assets.updateAsset("i1", { instrument: "pension_plan" });

    const after = (await store.assets.readAssets()).find((a) => a.id === "i1")!;
    expect(after.instrument).toBe("pension_plan");
    // No AssetType of its own: it keeps persisting through the investment path.
    expect(after.type).toBe("investment");

    const investment = await store.assets.readInvestmentAssetById("i1");
    expect(investment?.priceProvider).toBe("yahoo");
    expect(investment?.providerSymbol).toBe("SXR1.DE");
    store.close();
  });
});
