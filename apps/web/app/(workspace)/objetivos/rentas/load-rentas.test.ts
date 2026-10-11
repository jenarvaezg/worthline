/**
 * The Rentas read model (#1673): every declared income — with an asset or without
 * one — and, for the linked ones, the holding they hang from. Plus, for the ones
 * without an asset, how the scope on screen lets the sustainable-spending card read
 * them (#1811).
 */

import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import type { Workspace } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { loadRentas } from "./load-rentas";

const TODAY = "2026-10-11";

async function seed(store: WorthlineStore): Promise<Workspace> {
  await store.workspace.initializeWorkspace({
    members: [{ id: "mA", name: "Ana" }],
    mode: "individual",
  });
  return (await store.workspace.readWorkspace())!;
}

function load(store: WorthlineStore, workspace: Workspace, scopeId = "household") {
  return loadRentas({ scopeId, store, today: TODAY, workspace });
}

describe("loadRentas", () => {
  test("lists every income, with or without an asset, naming the linked holding", async () => {
    const store = await createInMemoryStore();
    const workspace = await seed(store);
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

    const model = await load(store, workspace);

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
    const workspace = await seed(store);

    expect(await load(store, workspace)).toEqual({
      cardContext: { cardShown: false, coversEveryMember: true },
      holdingById: {},
      incomes: [],
    });
  });

  test("without a FIRE plan declared ordinary, the card that reads an income with no asset is not drawn", async () => {
    const store = await createInMemoryStore();
    const workspace = await seed(store);

    expect((await load(store, workspace)).cardContext).toEqual({
      cardShown: false,
      coversEveryMember: true,
    });

    await store.saveFireConfig("household", {
      monthlySpendingMinor: 200_000,
      retirementPlan: "early",
      safeWithdrawalRate: 0.035,
    });
    expect((await load(store, workspace)).cardContext.cardShown).toBe(false);
  });

  test("reads the plan and the members of the scope on screen, not the household's", async () => {
    const store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [
        { id: "mA", name: "Ana" },
        { id: "mB", name: "Bea" },
      ],
      mode: "household",
    });
    const workspace = (await store.workspace.readWorkspace())!;
    await store.saveFireConfig("household", {
      monthlySpendingMinor: 200_000,
      retirementPlan: "early",
      safeWithdrawalRate: 0.035,
    });
    await store.saveFireConfig("mA", {
      monthlySpendingMinor: 100_000,
      retirementPlan: "ordinary",
      safeWithdrawalRate: 0.035,
    });

    expect((await load(store, workspace, "household")).cardContext).toEqual({
      cardShown: false,
      coversEveryMember: true,
    });
    expect((await load(store, workspace, "mA")).cardContext).toEqual({
      cardShown: true,
      coversEveryMember: false,
    });
  });
});
