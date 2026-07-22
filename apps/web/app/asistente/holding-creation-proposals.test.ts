import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { type InvestmentAssetRef, refreshStalePrices } from "@worthline/pricing";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  confirmHoldingCreationProposalAction,
  discardHoldingCreationProposalAction,
} from "./holding-creation-proposal-action";
import {
  buildHoldingCreationProposal,
  type HoldingCreationArgs,
} from "./holding-creation-proposals";

const TODAY = "2026-07-18";
const clock = { today: () => TODAY };

async function seedWorkspace(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

async function build(store: WorthlineStore, args: HoldingCreationArgs) {
  return buildHoldingCreationProposal(store, args, TODAY);
}

/** Project a created investment into the ref the reprice engine consumes. */
async function investmentRef(
  store: WorthlineStore,
  name: string,
): Promise<InvestmentAssetRef> {
  const meta = (await store.assets.readInvestmentAssetsWithMeta()).find(
    (m) => m.name === name,
  );
  if (!meta) throw new Error(`no investment named ${name}`);
  return {
    currency: meta.currency,
    id: meta.id,
    liquidityTier: meta.liquidityTier,
    priceProvider: meta.priceProvider,
    providerSymbol: meta.providerSymbol,
  };
}

describe("buildHoldingCreationProposal (#1105) · families", () => {
  test("stored asset → plan + positive impact", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta BBVA",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.family).toBe("stored");
    expect(built.proposal.impact).toEqual({
      afterMinor: 2_500_00,
      beforeMinor: 0,
      deltaMinor: 2_500_00,
    });
    expect(built.proposal.holding.detail).toContain("2500");
    store.close();
  });

  test("debt → plan + negative impact", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      balanceMinor: 120_000_00,
      family: "debt",
      instrument: "mortgage",
      name: "Hipoteca Santander",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.family).toBe("debt");
    expect(built.proposal.impact.deltaMinor).toBe(-120_000_00);
    store.close();
  });

  test("investment with opening → derived value impact", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "fund",
      name: "Fondo Índice",
      openingValueMinor: 1_500_00,
      pricePerUnit: "150",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.impact.deltaMinor).toBe(1_500_00);
    store.close();
  });

  test("investment without opening → empty container, zero impact", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "fund",
      name: "Fondo vacío",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.impact.deltaMinor).toBe(0);
    expect(built.proposal.holding.detail).toBe("Sin valoración de apertura");
    store.close();
  });

  test("investment with a resolved symbol → symbol on the card, no price warning", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "etf",
      name: "Vanguard S&P 500",
      providerSymbol: "VUSA.L",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.holding.providerSymbol).toBe("VUSA.L");
    expect(built.proposal.priceTrackingWarning).toBeUndefined();
    store.close();
  });

  test("investment without a symbol → price-tracking warning, no symbol shown", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "etf",
      name: "ETF sin ticker",
      openingValueMinor: 1_000_00,
      pricePerUnit: "100",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.holding.providerSymbol).toBeUndefined();
    expect(built.proposal.priceTrackingWarning).toMatch(/símbolo de mercado/i);
    store.close();
  });

  test("a non-investment alta never carries a price-tracking warning", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta sin símbolo",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.priceTrackingWarning).toBeUndefined();
    expect(built.proposal.holding.providerSymbol).toBeUndefined();
    store.close();
  });

  test("rejects a stored alta without a value", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "stored",
      instrument: "current_account",
      name: "Cuenta sin saldo",
    });
    expect(built.ok).toBe(false);
    store.close();
  });

  test("rejects an instrument that disagrees with the family", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      currentValueMinor: 1_000_00,
      family: "stored",
      instrument: "mortgage",
      name: "Mal encaje",
    });
    expect(built.ok).toBe(false);
    store.close();
  });
});

describe("buildHoldingCreationProposal (#1105) · duplicate warning", () => {
  test("0 matches → no duplicate", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta única",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.duplicate).toBeUndefined();
    store.close();
  });

  test("an ISIN match warns but never blocks", async () => {
    const store = await seedWorkspace();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "existing",
      instrument: "fund",
      isin: "ES00WL000001",
      liquidityTier: "market",
      name: "Fondo existente",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });
    const built = await build(store, {
      family: "investment",
      instrument: "fund",
      isin: "ES00WL000001",
      name: "Otro nombre",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.duplicate).toEqual({
      confidence: "strong",
      name: "Fondo existente",
    });
    store.close();
  });

  test("a name+instrument match warns (weak) but never blocks", async () => {
    const store = await seedWorkspace();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "cuenta1",
      instrument: "current_account",
      liquidityTier: "cash",
      name: "Cuenta BBVA",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "cash",
    });
    const built = await build(store, {
      currentValueMinor: 2_000_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta BBVA",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.duplicate).toEqual({
      confidence: "weak",
      name: "Cuenta BBVA",
    });
    store.close();
  });
});

describe("holding-creation server actions (#1105)", () => {
  test("confirm creates a stored asset and marks the proposal applied", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta BBVA",
    });
    if (!built.ok) throw new Error(built.error);

    const result = await confirmHoldingCreationProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    const assets = await store.assets.readAssets();
    expect(assets.map((a) => a.name)).toContain("Cuenta BBVA");
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("applied");
    store.close();
  });

  test("confirm creates a debt with its model", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      balanceMinor: 6_000_00,
      debtModel: "revolving",
      family: "debt",
      instrument: "credit_card",
      name: "Tarjeta",
    });
    if (!built.ok) throw new Error(built.error);

    const result = await confirmHoldingCreationProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    const liabilities = await store.liabilities.readLiabilities();
    const created = liabilities.find((l) => l.name === "Tarjeta");
    expect(created).toBeDefined();
    expect(await store.liabilities.readDebtModel(created!.id)).toBe("revolving");
    store.close();
  });

  test("confirm creates an investment with its opening operation", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "fund",
      name: "Fondo Índice",
      openingValueMinor: 1_500_00,
      pricePerUnit: "150",
    });
    if (!built.ok) throw new Error(built.error);

    const result = await confirmHoldingCreationProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    const investments = await store.assets.readInvestmentAssetsWithMeta();
    const created = investments.find((i) => i.name === "Fondo Índice");
    expect(created).toBeDefined();
    expect(await store.operations.readOperations(created!.id)).toHaveLength(1);
    store.close();
  });

  test("confirm carries the resolved providerSymbol onto the created investment", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "etf",
      name: "Vanguard S&P 500",
      openingValueMinor: 1_000_00,
      pricePerUnit: "100",
      providerSymbol: "VUSA.L",
    });
    if (!built.ok) throw new Error(built.error);

    const result = await confirmHoldingCreationProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "applied" });
    const investments = await store.assets.readInvestmentAssetsWithMeta();
    const created = investments.find((i) => i.name === "Vanguard S&P 500");
    // The symbol is what the daily capture / stale-price refresh key on to reprice.
    expect(created?.providerSymbol).toBe("VUSA.L");
    store.close();
  });

  test("discard drops the draft with no writes", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta BBVA",
    });
    if (!built.ok) throw new Error(built.error);

    const result = await discardHoldingCreationProposalAction(
      built.proposal.draft,
      store,
      clock,
    );

    expect(result).toEqual({ status: "discarded" });
    expect((await store.assets.readAssets()).map((a) => a.name)).not.toContain(
      "Cuenta BBVA",
    );
    expect(
      (await store.assistantProposals.read(built.proposal.draft.proposalId))?.status,
    ).toBe("discarded");
    store.close();
  });
});

describe("holding-creation reprice loop (#1186 · AC4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a chat-created ETF with a resolved symbol is repriced (not frozen)", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "etf",
      name: "Vanguard S&P 500",
      openingValueMinor: 1_000_00,
      pricePerUnit: "100",
      providerSymbol: "VUSA.L",
    });
    if (!built.ok) throw new Error(built.error);
    await confirmHoldingCreationProposalAction(built.proposal.draft, store, clock);

    // Yahoo quote for the created ETF — the symbol is what the fetch keys on.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: { currency: "EUR", regularMarketPrice: 123.45 },
                timestamp: [Math.floor(Date.parse("2026-07-18T08:00:00Z") / 1000)],
                indicators: { quote: [{ close: [123.45] }] },
              },
            ],
          },
        }),
      })),
    );

    const ref = await investmentRef(store, "Vanguard S&P 500");
    // force:true refetches every asset that HAS a provider symbol (#317): the
    // chat-created holding qualifies and reprices instead of freezing at opening.
    const result = await refreshStalePrices([], [ref], "2026-07-18T10:00:00Z", {
      force: true,
    });

    expect(result.refreshed).toHaveLength(1);
    expect(result.refreshed[0]).toMatchObject({ assetId: ref.id, price: "123.45" });
    store.close();
  });

  test("a chat-created investment WITHOUT a symbol is skipped by the reprice loop", async () => {
    const store = await seedWorkspace();
    const built = await build(store, {
      family: "investment",
      instrument: "etf",
      name: "ETF congelado",
      openingValueMinor: 1_000_00,
      pricePerUnit: "100",
    });
    if (!built.ok) throw new Error(built.error);
    await confirmHoldingCreationProposalAction(built.proposal.draft, store, clock);

    // No provider symbol → refresh-stale-prices drops it before any fetch: the
    // holding stays frozen at its opening valuation (the gap #1186 closes).
    const ref = await investmentRef(store, "ETF congelado");
    expect(ref.providerSymbol).toBeUndefined();
    const result = await refreshStalePrices([], [ref], "2026-07-18T10:00:00Z", {
      force: true,
    });

    expect(result.refreshed).toHaveLength(0);
    store.close();
  });
});
