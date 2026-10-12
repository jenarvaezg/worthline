/**
 * A hand-set price keeps the day it was SET (#1828).
 *
 * The ficha says «precio a mano · 03/10/2026» beside the price that valued the
 * holding, so `manual_priced_at` has to be the day that price was typed. It used to
 * be stamped once, at the alta, and never again: change the price a month later and
 * the header would have dated the new figure with the old day. Saving «Lo básico»
 * re-submits the price every time, so an unchanged price must keep its day — or
 * renaming the fund would pass for a fresh quote.
 */

import { createInMemoryStore } from "@db/testing";
import { afterEach, describe, expect, test, vi } from "vitest";

const own = [{ memberId: "m", shareBps: 10_000 }];

async function freshStore() {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/** Pin the clock — only `Date`, so the database driver's timers are left alone. */
function at(instant: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
}

const edit = (manualPricePerUnit: string | undefined, name = "Fondo") => ({
  id: "fund",
  name,
  ...(manualPricePerUnit === undefined ? {} : { manualPricePerUnit }),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the hand-set price keeps the day it was set (#1828)", () => {
  test("a new price is dated the day it is saved; an unchanged one keeps its day", async () => {
    const store = await freshStore();
    try {
      at("2026-09-01T10:00:00.000Z");
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        manualPricePerUnit: "100",
        name: "Fondo",
        ownership: own,
      });
      expect((await store.assets.readInvestmentAssetById("fund"))?.manualPricedAt).toBe(
        "2026-09-01T10:00:00.000Z",
      );

      // «Lo básico» saved to rename it: the price rides along, the same figure.
      at("2026-09-20T10:00:00.000Z");
      await store.assets.updateInvestmentAsset(edit("100", "Fondo Azul"));
      expect((await store.assets.readInvestmentAssetById("fund"))?.manualPricedAt).toBe(
        "2026-09-01T10:00:00.000Z",
      );

      // A new figure: the day it was typed.
      at("2026-10-03T09:15:00.000Z");
      await store.assets.updateInvestmentAsset(edit("118.75", "Fondo Azul"));
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
      at("2026-09-01T10:00:00.000Z");
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

      at("2026-10-03T09:15:00.000Z");
      await store.assets.updateInvestmentAsset(edit("118.75"));
      expect((await store.assets.readInvestmentAssetById("fund"))?.manualPricedAt).toBe(
        "2026-10-03T09:15:00.000Z",
      );

      await store.assets.updateInvestmentAsset(edit(undefined));
      const cleared = await store.assets.readInvestmentAssetById("fund");
      expect(cleared?.manualPricePerUnit).toBeUndefined();
      expect(cleared?.manualPricedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
