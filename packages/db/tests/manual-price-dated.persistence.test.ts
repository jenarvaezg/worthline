/**
 * A hand-set price keeps the day it was SET (#1828).
 *
 * The ficha says «precio a mano · 03/10/2026» beside the price that valued the
 * holding, so `manual_priced_at` has to be the day that price was typed. It used to
 * be stamped once, at the alta, and never again: change the price a month later and
 * the header would have dated the new figure with the old day. Saving «Lo básico»
 * re-submits the price every time, so an unchanged price must keep its day — or
 * renaming the fund would pass for a fresh quote. The instant is the caller's
 * (`savedAt`, ADR 0024): the store never reads the wall clock for it.
 */

import { createInMemoryStore } from "@db/testing";
import { describe, expect, test } from "vitest";

const own = [{ memberId: "m", shareBps: 10_000 }];

async function freshStore() {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

const save = (
  manualPricePerUnit: string | undefined,
  savedAt: string | undefined,
  name = "Fondo",
) => ({
  id: "fund",
  name,
  ...(manualPricePerUnit === undefined ? {} : { manualPricePerUnit }),
  ...(savedAt === undefined ? {} : { savedAt }),
});

describe("the hand-set price keeps the day it was set (#1828)", () => {
  test("a new price is dated by its save; an unchanged one keeps its day", async () => {
    const store = await freshStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        manualPricePerUnit: "100",
        name: "Fondo",
        ownership: own,
      });
      const atAlta = (await store.assets.readInvestmentAssetById("fund"))?.manualPricedAt;
      expect(atAlta).toEqual(expect.any(String));

      // «Lo básico» saved to rename it: the price rides along, the same figure.
      await store.assets.updateInvestmentAsset(
        save("100", "2026-09-20T10:00:00.000Z", "Fondo Azul"),
      );
      expect((await store.assets.readInvestmentAssetById("fund"))?.manualPricedAt).toBe(
        atAlta,
      );

      // A new figure: the instant of the save that typed it.
      await store.assets.updateInvestmentAsset(
        save("118.75", "2026-10-03T09:15:00.000Z", "Fondo Azul"),
      );
      const repriced = await store.assets.readInvestmentAssetById("fund");
      expect(repriced?.manualPricePerUnit).toBe("118.75");
      expect(repriced?.manualPricedAt).toBe("2026-10-03T09:15:00.000Z");
    } finally {
      store.close();
    }
  });

  test("a price set after the alta is dated then, and clearing it clears its day", async () => {
    const store = await freshStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        name: "Fondo",
        ownership: own,
      });
      expect(
        (await store.assets.readInvestmentAssetById("fund"))?.manualPricedAt,
      ).toBeUndefined();

      await store.assets.updateInvestmentAsset(
        save("118.75", "2026-10-03T09:15:00.000Z"),
      );
      expect((await store.assets.readInvestmentAssetById("fund"))?.manualPricedAt).toBe(
        "2026-10-03T09:15:00.000Z",
      );

      await store.assets.updateInvestmentAsset(
        save(undefined, "2026-10-04T09:15:00.000Z"),
      );
      const cleared = await store.assets.readInvestmentAssetById("fund");
      expect(cleared?.manualPricePerUnit).toBeUndefined();
      expect(cleared?.manualPricedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("a caller that does not say when leaves a changed price undated", async () => {
    const store = await freshStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        manualPricePerUnit: "100",
        name: "Fondo",
        ownership: own,
      });

      await store.assets.updateInvestmentAsset(save("118.75", undefined));

      // Not the alta's day — that dated another figure — and not a guessed one.
      const repriced = await store.assets.readInvestmentAssetById("fund");
      expect(repriced?.manualPricePerUnit).toBe("118.75");
      expect(repriced?.manualPricedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
