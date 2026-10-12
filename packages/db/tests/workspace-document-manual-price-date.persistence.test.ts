/**
 * The day a hand-set price was set, across the workspace document's door (#1731
 * review, ADR 0104: one door, two readers).
 *
 * The v72 rung cleared every `manual_priced_at` already stored, because until #1828
 * it was stamped only at the alta and a stamp could not be told from the day the
 * price was typed. A restore must not bring those stamps back: a backup written
 * before the rung carries them under `manualPricedAt`, and the document has no
 * schema version to tell old from new (its `version` is the format's, and bumping it
 * would refuse every backup on disk). So the field changed name with its meaning:
 * the export writes `manualPriceSetAt` — a stamp every price change rewrites — and
 * the legacy `manualPricedAt` is still accepted, so an old file keeps restoring, but
 * its day is not: the price comes back with none, as the rung left it.
 */
import { createInMemoryStore } from "@db/index";
import type { WorkspaceExport } from "@worthline/domain";
import { serializeWorkspaceExport } from "@worthline/domain";
import { describe, expect, test } from "vitest";

/** A minimal document with ONE fund and the metadata handed in. */
function documentWithInvestment(investment: Record<string, unknown>): WorkspaceExport {
  return serializeWorkspaceExport({
    assets: [
      {
        currency: "EUR",
        id: "a1",
        investment,
        isPrimaryResidence: false,
        liquidityTier: "market",
        name: "Fondo",
        ownership: [{ memberId: "m1", shareBps: 10000 }],
        type: "investment",
      },
    ],
    connectedSources: [],
    fireConfig: {},
    groups: [],
    liabilities: [],
    members: [{ id: "m1", name: "Jorge" }],
    operations: [],
    priceCache: [],
    snapshots: [],
    trash: { assets: [], liabilities: [] },
    warningOverrides: [],
    workspace: { baseCurrency: "EUR", mode: "individual" },
  });
}

async function importAndRead(investment: Record<string, unknown>) {
  const store = await createInMemoryStore();
  try {
    await store.workspace.importWorkspace(documentWithInvestment(investment));
    return await store.assets.readInvestmentAssetById("a1");
  } finally {
    store.close();
  }
}

describe("the day a hand-set price was set, through a backup (#1731 review)", () => {
  test("a backup from before the rung restores the price, never its alta stamp", async () => {
    const row = await importAndRead({
      manualPricePerUnit: "118.75",
      manualPricedAt: "2026-03-01T09:00:00.000Z",
    });

    expect(row?.manualPricePerUnit).toBe("118.75");
    expect(row?.manualPricedAt).toBeUndefined();
  });

  test("a stamp written since the rung travels both ways under its new name", async () => {
    const store = await createInMemoryStore();
    try {
      await store.workspace.importWorkspace(
        documentWithInvestment({
          manualPricePerUnit: "118.75",
          manualPriceSetAt: "2026-10-03T09:15:00.000Z",
        }),
      );

      expect((await store.assets.readInvestmentAssetById("a1"))?.manualPricedAt).toBe(
        "2026-10-03T09:15:00.000Z",
      );
      const exported = await store.workspace.exportWorkspace();
      const investment = exported.assets.find((asset) => asset.id === "a1")?.investment;
      expect(investment).toMatchObject({ manualPriceSetAt: "2026-10-03T09:15:00.000Z" });
      expect(investment).not.toHaveProperty("manualPricedAt");
    } finally {
      store.close();
    }
  });
});
