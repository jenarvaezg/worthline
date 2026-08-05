import { createInMemoryStore } from "@db/index";
import { describe, expect, test } from "vitest";

const TODAY = "2026-08-05";

async function seedStore() {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/**
 * The reason `patchInvestmentIdentity` exists instead of reusing
 * `updateInvestmentAsset` (#1349): the assistant's correction carries only the
 * fields being filled, and the form-shaped update nulls every metadata column it
 * is not given.
 */
describe("patchInvestmentIdentity (#1349)", () => {
  test("fills the ISIN without dropping the rest of the metadata", async () => {
    const store = await seedStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        manualPricePerUnit: "12.34",
        name: "Fondo",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
        unitSymbol: "uds",
      });

      const updated = await store.assets.patchInvestmentIdentity("fund", {
        isin: "IE00B03HCZ61",
      });

      expect(updated).toBe(1);
      const meta = await store.assets.readInvestmentAssetById("fund");
      expect(meta?.isin).toBe("IE00B03HCZ61");
      expect(meta?.unitSymbol).toBe("uds");
      expect(meta?.manualPricePerUnit).toBe("12.34");
      expect(meta?.providerSymbol).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("an empty patch writes nothing", async () => {
    const store = await seedStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        name: "Fondo",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
      });

      expect(await store.assets.patchInvestmentIdentity("fund", {})).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a symbol fill clears the price cache row the old configuration left", async () => {
    const store = await seedStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        name: "Fondo",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
      });
      await store.command.recordInvestmentOperation(
        {
          assetId: "fund",
          currency: "EUR",
          executedAt: "2026-06-01",
          feesMinor: 0,
          id: "op1",
          kind: "buy",
          pricePerUnit: "4.10",
          source: "manual",
          units: "100",
        },
        { today: TODAY },
      );
      await store.operations.upsertPrice({
        assetId: "fund",
        currency: "EUR",
        fetchedAt: `${TODAY}T09:00:00.000Z`,
        freshnessState: "fresh",
        price: "4.10",
        source: "yahoo",
      });
      expect(await store.operations.readPriceCache("fund")).not.toBeNull();

      const proposal = await store.assistantProposals.create({ kind: "correction" });
      await store.assistantProposals.appendDocument(proposal.id, {
        document: {
          name: "declaración-del-usuario",
          provenance: "user",
          sha256: "a".repeat(64),
        },
        facts: [
          {
            kind: "holding_correction",
            row: {
              edits: [
                {
                  assetId: "fund",
                  before: { isin: null, providerSymbol: null },
                  declaration: { providerSymbol: "SAN.MC" },
                  kind: "investment_identity",
                },
              ],
              holding: "wl_hld_fund",
              mode: "anchor-only",
            },
          },
        ],
      });

      await store.command.applyAssistantCorrectionProposal({
        proposalId: proposal.id,
        today: TODAY,
      });

      const meta = await store.assets.readInvestmentAssetById("fund");
      expect(meta?.providerSymbol).toBe("SAN.MC");
      // A cache row minted for the previous configuration would price the new
      // symbol from the old figure.
      expect(await store.operations.readPriceCache("fund")).toBeNull();
    } finally {
      store.close();
    }
  });
});
