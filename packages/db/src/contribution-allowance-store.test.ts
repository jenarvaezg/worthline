/**
 * Annual contribution allowance CRUD round-trip (#1427): the cap and its
 * destination set persist through create / read / update / delete against a real
 * SQLite database migrated to the current schema version.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorthlineStoreUnsafe } from "./unsafe-store";

async function freshStore(): Promise<
  Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>
> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-allowance-")), "w.sqlite");
  const store = await createWorthlineStoreUnsafe({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  for (const id of ["pp1", "pp2"]) {
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id,
      liquidityTier: "market",
      name: id,
      ownership: [{ memberId: "m1", shareBps: 10_000 }],
      type: "investment",
    });
  }
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 1_000_00,
    id: "cuenta",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: [{ memberId: "m1", shareBps: 10_000 }],
    type: "cash",
  });
  return store;
}

describe("contribution allowance CRUD", () => {
  it("creates an allowance with its destinations and reads it back", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1", "pp2"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    const rows =
      await store.contributionAllowances.readContributionAllowances("household");
    expect(rows).toEqual([
      {
        annualCapMinor: 1_500_00,
        holdingIds: ["pp1", "pp2"],
        id: created.id,
        label: "Planes de pensiones",
        scopeId: "household",
      },
    ]);
  });

  it("scopes the read — another scope's allowance is invisible", async () => {
    const store = await freshStore();
    await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1"],
      label: "Planes de pensiones",
      scopeId: "m1",
    });

    expect(
      await store.contributionAllowances.readContributionAllowances("household"),
    ).toEqual([]);
  });

  it("de-duplicates destinations — the same holding twice would double-count", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1", "pp1"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    expect(created.holdingIds).toEqual(["pp1"]);
    const [row] =
      await store.contributionAllowances.readContributionAllowances("household");
    expect(row?.holdingIds).toEqual(["pp1"]);
  });

  it("rejects an allowance with no destination", async () => {
    const store = await freshStore();
    await expect(
      store.contributionAllowances.createContributionAllowance({
        annualCapMinor: 1_500_00,
        holdingIds: [],
        label: "Planes de pensiones",
        scopeId: "household",
      }),
    ).rejects.toThrow(/destino/i);
  });

  it("rejects a non-positive cap", async () => {
    const store = await freshStore();
    await expect(
      store.contributionAllowances.createContributionAllowance({
        annualCapMinor: 0,
        holdingIds: ["pp1"],
        label: "Planes de pensiones",
        scopeId: "household",
      }),
    ).rejects.toThrow(/tope/i);
  });

  it("updates the cap without touching the destination set", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1", "pp2"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    await store.contributionAllowances.updateContributionAllowance(created.id, {
      annualCapMinor: 1_000_00,
    });

    const [row] =
      await store.contributionAllowances.readContributionAllowances("household");
    expect(row).toMatchObject({ annualCapMinor: 1_000_00, holdingIds: ["pp1", "pp2"] });
  });

  it("rewrites the destination set when the patch carries one", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1", "pp2"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    await store.contributionAllowances.updateContributionAllowance(created.id, {
      holdingIds: ["pp2"],
      label: "Plan de empleo",
    });

    const [row] =
      await store.contributionAllowances.readContributionAllowances("household");
    expect(row).toMatchObject({ holdingIds: ["pp2"], label: "Plan de empleo" });
  });

  it("refuses an update that would leave the allowance with no destination", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    await expect(
      store.contributionAllowances.updateContributionAllowance(created.id, {
        holdingIds: [],
      }),
    ).rejects.toThrow(/destino/i);
    const [row] =
      await store.contributionAllowances.readContributionAllowances("household");
    expect(row?.holdingIds).toEqual(["pp1"]);
  });

  it("refuses a destination with no operation ledger — it would count 0 and lie", async () => {
    const store = await freshStore();
    await expect(
      store.contributionAllowances.createContributionAllowance({
        annualCapMinor: 1_500_00,
        holdingIds: ["cuenta"],
        label: "Planes de pensiones",
        scopeId: "household",
      }),
    ).rejects.toThrow(/inversiones/i);
  });

  it("refuses an unknown destination", async () => {
    const store = await freshStore();
    await expect(
      store.contributionAllowances.createContributionAllowance({
        annualCapMinor: 1_500_00,
        holdingIds: ["fantasma"],
        label: "Planes de pensiones",
        scopeId: "household",
      }),
    ).rejects.toThrow(/no existe/i);
  });

  it("guards the destination set on update too", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    await expect(
      store.contributionAllowances.updateContributionAllowance(created.id, {
        holdingIds: ["cuenta"],
      }),
    ).rejects.toThrow(/inversiones/i);
    const [row] =
      await store.contributionAllowances.readContributionAllowances("household");
    expect(row?.holdingIds).toEqual(["pp1"]);
  });

  it("deletes the allowance and its links", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    await store.contributionAllowances.deleteContributionAllowance(created.id);
    expect(
      await store.contributionAllowances.readContributionAllowances("household"),
    ).toEqual([]);
  });
});

describe("contribution allowance transfer", () => {
  it("survives an export/import round-trip — a traspaso must not drop the cupo", async () => {
    const store = await freshStore();
    const created = await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1", "pp2"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    const exported = await store.workspace.exportWorkspace();
    expect(exported.contributionAllowances).toEqual([
      {
        annualCapMinor: 1_500_00,
        holdingIds: ["pp1", "pp2"],
        id: created.id,
        label: "Planes de pensiones",
        scopeId: "household",
      },
    ]);

    await store.workspace.importWorkspace(exported);

    expect(
      await store.contributionAllowances.readContributionAllowances("household"),
    ).toEqual(exported.contributionAllowances);
  });

  it("exports no consumed total — it is derived from the operations that travel with it", async () => {
    const store = await freshStore();
    await store.contributionAllowances.createContributionAllowance({
      annualCapMinor: 1_500_00,
      holdingIds: ["pp1"],
      label: "Planes de pensiones",
      scopeId: "household",
    });

    const exported = await store.workspace.exportWorkspace();

    expect(Object.keys(exported.contributionAllowances[0] ?? {}).sort()).toEqual([
      "annualCapMinor",
      "holdingIds",
      "id",
      "label",
      "scopeId",
    ]);
  });
});
