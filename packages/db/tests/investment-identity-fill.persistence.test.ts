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
        securityId: { kind: "isin", value: "IE00B03HCZ61" },
      });

      expect(updated).toBe(1);
      const meta = await store.assets.readInvestmentAssetById("fund");
      expect(meta?.securityId).toEqual({ kind: "isin", value: "IE00B03HCZ61" });
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

  test("refuses a value that is not of its declared kind and writes nothing (#1453)", async () => {
    const store = await seedStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        name: "Fondo",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
      });

      await expect(
        store.assets.patchInvestmentIdentity("fund", {
          securityId: { kind: "isin", value: "N5394" },
        }),
      ).rejects.toThrow(/ISIN/);
      const meta = await store.assets.readInvestmentAssetById("fund");
      expect(meta?.securityId).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("stores a valid ISIN normalized to upper case", async () => {
    const store = await seedStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "fund",
        liquidityTier: "market",
        name: "Fondo",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
      });

      await store.assets.patchInvestmentIdentity("fund", {
        securityId: { kind: "isin", value: " ie00b03hcz61 " },
      });
      const meta = await store.assets.readInvestmentAssetById("fund");
      expect(meta?.securityId).toEqual({ kind: "isin", value: "IE00B03HCZ61" });
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
                  before: { providerSymbol: null, securityId: null },
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

      await store.command.applyAssistantProposal({
        kind: "correction",
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

/**
 * The identifier columns accept only what their declared kind is (#1453,
 * generalizado en #1743): every write path funnels through the store, so refusing
 * here cuts the whole failure class — un valor que no es de su clase hace que el
 * catálogo de exposición registre la fila bajo la clave del proveedor mientras el
 * look-through la busca bajo otra, y el holding se queda «sin clasificar» sin que
 * nada avise.
 */
describe("security id column validation (#1453, #1743)", () => {
  async function seedFund(store: Awaited<ReturnType<typeof seedStore>>) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });
  }

  test("createInvestmentAsset refuses a DGS code declared as an ISIN", async () => {
    const store = await seedStore();
    try {
      await expect(
        store.assets.createInvestmentAsset({
          currency: "EUR",
          id: "fund",
          liquidityTier: "market",
          name: "Fondo",
          ownership: [{ memberId: "m", shareBps: 10_000 }],
          securityId: { kind: "isin", value: "N5394" },
        }),
      ).rejects.toThrow(/ISIN/);
    } finally {
      store.close();
    }
  });

  // El destino de #1741: el identificador de un plan de pensiones ENTRA, con su
  // clase propia, y no tiene que disfrazarse de ISIN para caber en la columna.
  test("createInvestmentAsset stores a plan's DGS code as what it is", async () => {
    const store = await seedStore();
    try {
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "plan",
        instrument: "pension_plan",
        liquidityTier: "term-locked",
        name: "PP Indexado",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
        securityId: { kind: "dgs", value: "n-5394" },
      });

      const meta = await store.assets.readInvestmentAssetById("plan");
      expect(meta?.securityId).toEqual({ kind: "dgs", value: "N5394" });
    } finally {
      store.close();
    }
  });

  test("createInvestmentAsset refuses the pension FUND code with its guidance", async () => {
    const store = await seedStore();
    try {
      await expect(
        store.assets.createInvestmentAsset({
          currency: "EUR",
          id: "plan",
          liquidityTier: "term-locked",
          name: "PP Indexado",
          ownership: [{ memberId: "m", shareBps: 10_000 }],
          securityId: { kind: "dgs", value: "F2244" },
        }),
      ).rejects.toThrow(/empieza por N/);
    } finally {
      store.close();
    }
  });

  test("updateInvestmentAsset refuses a value of the wrong kind and writes nothing", async () => {
    const store = await seedStore();
    try {
      await seedFund(store);
      await expect(
        store.assets.updateInvestmentAsset({
          id: "fund",
          name: "Fondo renombrado",
          securityId: { kind: "isin", value: "N5394" },
        }),
      ).rejects.toThrow(/ISIN/);
      const meta = await store.assets.readInvestmentAssetById("fund");
      expect(meta?.securityId).toBeUndefined();
      expect(meta?.name).toBe("Fondo");
    } finally {
      store.close();
    }
  });

  test("backfillInvestmentSecurityId refuses the wrong kind and normalizes a valid one", async () => {
    const store = await seedStore();
    try {
      await seedFund(store);
      await expect(
        store.assets.backfillInvestmentSecurityId("fund", {
          kind: "isin",
          value: "N5394",
        }),
      ).rejects.toThrow(/ISIN/);

      const updated = await store.assets.backfillInvestmentSecurityId("fund", {
        kind: "isin",
        value: "ie00b03hcz61",
      });
      expect(updated).toBe(1);
      const meta = await store.assets.readInvestmentAssetById("fund");
      expect(meta?.securityId).toEqual({ kind: "isin", value: "IE00B03HCZ61" });
    } finally {
      store.close();
    }
  });
});
