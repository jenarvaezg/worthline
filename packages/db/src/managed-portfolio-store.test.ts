/**
 * Managed portfolio persistence (ADR 0085, #1547): the `managed_portfolios`
 * rows and their exclusive `managed_portfolio_holdings` memberships, plus the
 * auto-created cash sibling, against a real SQLite database migrated to the
 * current schema version.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OwnershipShare } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createWorthlineStoreUnsafe } from "./unsafe-store";

type TestStore = Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>;

const M1_OWNERSHIP: OwnershipShare[] = [{ memberId: "m1", shareBps: 10_000 }];

async function freshStore(): Promise<{ coin: string; store: TestStore }> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-portfolio-")), "w.sqlite");
  const store = await createWorthlineStoreUnsafe({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "individual",
  });
  // Two live manual investments (the eligible members)…
  for (const id of ["f1", "f2"]) {
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id,
      liquidityTier: "market",
      name: id,
      ownership: M1_OWNERSHIP,
      type: "investment",
    });
  }
  // …a connected-source investment (prohibited)…
  const { sourceId } = await store.connectedSources.connect({
    adapter: "binance",
    credentialsJson: "{}",
    label: "Binance",
    ownership: M1_OWNERSHIP,
  });
  const [coin] = await store.connectedSources.listSourceAssetIds(sourceId);
  // …and a plain cash account (never a member — the portfolio spawns its own).
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100_00,
    id: "cuenta",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: M1_OWNERSHIP,
    type: "cash",
  });
  return { coin: coin!, store };
}

async function createMetal(store: TestStore, memberHoldingIds?: string[]) {
  return store.managedPortfolios.createManagedPortfolio({
    cashOwnership: M1_OWNERSHIP,
    ...(memberHoldingIds === undefined ? {} : { memberHoldingIds }),
    name: "Cartera Indexada Metal",
    provider: "MyInvestor",
    scopeId: "household",
  });
}

describe("managed portfolio CRUD", () => {
  it("creates the portfolio with an auto-created cash sibling as first member", async () => {
    const { store } = await freshStore();
    const created = await createMetal(store);

    expect(created.name).toBe("Cartera Indexada Metal");
    expect(created.provider).toBe("MyInvestor");
    expect(created.holdingIds).toHaveLength(1);

    const [cash] = await Promise.all(
      created.holdingIds.map((id) =>
        store.assets.readAssets().then((assets) => assets.find((a) => a.id === id)),
      ),
    );
    expect(cash).toBeDefined();
    expect(cash?.type).toBe("cash");
    expect(cash?.instrument).toBe("current_account");
    expect(cash?.currentValue.amountMinor).toBe(0);
    expect(cash?.name).toContain("Efectivo");

    const rows = await store.managedPortfolios.readManagedPortfolios("household");
    expect(rows).toEqual([created]);
  });

  it("links the enumerated investment members at birth", async () => {
    const { store } = await freshStore();
    const created = await createMetal(store, ["f1", "f2"]);

    // The cash sibling rides along with the two funds (its presence and shape
    // are asserted in the create test above).
    expect(created.holdingIds).toContain("f1");
    expect(created.holdingIds).toContain("f2");
  });

  it("de-duplicates members — the same holding twice is one membership", async () => {
    const { store } = await freshStore();
    const created = await createMetal(store, ["f1", "f1"]);

    expect(created.holdingIds.filter((id) => id === "f1")).toHaveLength(1);
  });

  it("rejects a blank name", async () => {
    const { store } = await freshStore();
    await expect(
      store.managedPortfolios.createManagedPortfolio({
        cashOwnership: M1_OWNERSHIP,
        name: "   ",
        scopeId: "household",
      }),
    ).rejects.toThrow("La cartera necesita un nombre.");
  });

  it("rejects an unknown holding", async () => {
    const { store } = await freshStore();
    await expect(createMetal(store, ["fantasma"])).rejects.toThrow(
      'El activo "fantasma" no existe.',
    );
  });

  it("rejects a non-investment member — only investments can be members", async () => {
    const { store } = await freshStore();
    await expect(createMetal(store, ["cuenta"])).rejects.toThrow(
      /Solo los holdings de inversión/,
    );
  });

  it("rejects a connected-source holding (prohibited for now)", async () => {
    const { coin, store } = await freshStore();
    await expect(createMetal(store, [coin])).rejects.toThrow(/fuente conectada/);
  });

  it("rejects a trashed holding — membership needs a live holding", async () => {
    const { store } = await freshStore();
    await store.batchSoftDeleteHoldings(
      [{ holdingId: "f1", kind: "asset" }],
      "2026-08-22T00:00:00.000Z",
    );

    await expect(createMetal(store, ["f1"])).rejects.toThrow(/papelera/);
  });

  it("enforces exclusive membership across portfolios", async () => {
    const { store } = await freshStore();
    await createMetal(store, ["f1"]);
    await expect(
      store.managedPortfolios.createManagedPortfolio({
        cashOwnership: M1_OWNERSHIP,
        memberHoldingIds: ["f2"],
        name: "Otra cartera",
        scopeId: "household",
      }),
    ).resolves.toBeDefined();

    // f1 is already Metal's; f2 belongs to the second portfolio now.
    await expect(
      store.managedPortfolios.updateManagedPortfolio(
        (await store.managedPortfolios.readManagedPortfolios("household"))[0]!.id,
        { memberHoldingIds: ["f2"] },
      ),
    ).rejects.toThrow(/ya pertenece a la cartera/);
  });

  it("rewrites members on update but always preserves the cash sibling", async () => {
    const { store } = await freshStore();
    const created = await createMetal(store, ["f1"]);
    const cashId = created.holdingIds.find((id) => id !== "f1")!;

    await store.managedPortfolios.updateManagedPortfolio(created.id, {
      memberHoldingIds: [],
      name: "Cartera Metal",
      provider: null,
    });

    const [row] = await store.managedPortfolios.readManagedPortfolios("household");
    expect(row?.name).toBe("Cartera Metal");
    expect(row?.provider).toBeNull();
    // The only surviving link is the auto-created cash sibling.
    expect(row?.holdingIds).toEqual([cashId]);
  });

  it("deletes the portfolio and its links without touching any holding", async () => {
    const { store } = await freshStore();
    const created = await createMetal(store, ["f1", "f2"]);

    await store.managedPortfolios.deleteManagedPortfolio(created.id);

    expect(await store.managedPortfolios.readManagedPortfolios("household")).toEqual([]);
    const assets = await store.assets.readAssets();
    for (const id of ["f1", "f2", ...created.holdingIds]) {
      expect(assets.find((asset) => asset.id === id)).toBeDefined();
    }
    // After the delete, membership frees up again.
    await expect(createMetal(store, ["f1"])).resolves.toBeDefined();
  });

  it("scopes reads — another scope's portfolio is invisible", async () => {
    const { store } = await freshStore();
    await store.managedPortfolios.createManagedPortfolio({
      cashOwnership: M1_OWNERSHIP,
      name: "De Uno",
      scopeId: "m1",
    });

    expect(await store.managedPortfolios.readManagedPortfolios("household")).toEqual([]);
  });
});
