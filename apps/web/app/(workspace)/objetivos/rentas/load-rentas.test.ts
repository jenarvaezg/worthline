/**
 * The Rentas read model (#1673): every declared income — with an asset or without
 * one — and, for the linked ones, the holding they hang from.
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { loadRentas } from "./load-rentas";

async function seed(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mA", name: "Ana" }],
    mode: "individual",
  });
}

describe("loadRentas", () => {
  test("lists every income, with or without an asset, naming the linked holding", async () => {
    const store = await createInMemoryStore();
    await seed(store);
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_flat",
      liquidityTier: "illiquid",
      name: "Piso alquilado",
      ownership: [{ memberId: "mA", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.payouts.createPayoutSchedule({
      amountMinor: 90_000,
      cadence: "monthly",
      holdingId: "asset_flat",
      label: "Alquiler",
      startISO: "2024-01-01",
    });
    await store.payouts.createPayoutSchedule({
      amountMinor: 150_000,
      cadence: "monthly",
      label: "Pensión pública",
      startISO: "2030-11-01",
    });

    const model = await loadRentas({ store });

    // The display order is the ledger's (after its optimistic fold), not the loader's.
    expect(model.incomes.map((income) => income.label).sort()).toEqual([
      "Alquiler",
      "Pensión pública",
    ]);
    expect(model.holdingById["asset_flat"]).toEqual({
      name: "Piso alquilado",
      href: expect.stringMatching(
        /^\/patrimonio\/wl_hld_.+\/editar\?abrir=cobros#cobros$/,
      ),
    });
  });

  test("an empty workspace has no incomes and reads no holdings", async () => {
    const store = await createInMemoryStore();
    await seed(store);

    expect(await loadRentas({ store })).toEqual({ holdingById: {}, incomes: [] });
  });
});
