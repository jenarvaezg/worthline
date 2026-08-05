import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import { chatToolStores } from "./chat-tools";
import { confirmCorrectionProposalAction } from "./correction-proposal-action";
import { buildCorrectionProposal, type CorrectionArgs } from "./correction-proposals";

const TODAY = "2026-08-05";

/** A quote seam that always resolves — the symbol's existence is not the subject. */
const RESOLVES = async () => ({ ok: true as const, quotedPricePerUnit: "11.90" });

async function seedWorkspace(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

async function seedFund(
  store: WorthlineStore,
  input: { id: string; name: string; isin?: string; providerSymbol?: string },
): Promise<void> {
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: input.id,
    liquidityTier: "market",
    name: input.name,
    ownership: [{ memberId: "m", shareBps: 10_000 }],
    ...(input.isin ? { isin: input.isin } : {}),
    ...(input.providerSymbol ? { providerSymbol: input.providerSymbol } : {}),
  });
}

/** The 1-participación opening the chat alta writes for a value-only declaration. */
async function seedValueOnlyOpening(
  store: WorthlineStore,
  assetId: string,
  totalMinor: number,
): Promise<void> {
  await store.command.recordInvestmentOperation(
    {
      assetId,
      currency: "EUR",
      executedAt: "2026-07-01",
      feesMinor: 0,
      id: `op_${assetId}`,
      kind: "buy",
      pricePerUnit: (totalMinor / 100).toFixed(2),
      source: "opening",
      units: "1",
    },
    { today: TODAY },
  );
}

function args(
  correction: CorrectionArgs["correction"],
  holdingId = "fund",
): CorrectionArgs {
  return { correction, holdingId, publicHoldingId: `wl_hld_${holdingId}` };
}

async function isinOf(store: WorthlineStore, assetId: string) {
  const meta = await store.assets.readInvestmentAssetById(assetId);
  return meta?.isin ?? null;
}

async function symbolOf(store: WorthlineStore, assetId: string) {
  const meta = await store.assets.readInvestmentAssetById(assetId);
  return meta?.providerSymbol ?? null;
}

describe("edit_identity (#1349)", () => {
  test("fills an empty ISIN and the confirm writes it", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Vanguard Global Stock" });

    const built = await buildCorrectionProposal(
      store,
      args({ isin: "IE00B03HCZ61", kind: "edit_identity" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.mode).toBe("solo-desde-hoy");
    if (built.proposal.mode !== "solo-desde-hoy") return;
    expect(built.proposal.edits).toEqual([
      { after: "IE00B03HCZ61", before: "—", label: "ISIN", origin: "assistant" },
    ]);

    const applied = await confirmCorrectionProposalAction(
      built.proposal.draft,
      store,
      TODAY,
    );
    expect(applied.status).toBe("applied");
    expect(await isinOf(store, "fund")).toBe("IE00B03HCZ61");
    store.close();
  });

  test("fills an empty provider symbol on a curated ledger", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Santander" });
    // Two operations: a human-curated ledger, outside the #1329 guard.
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
    await store.command.recordInvestmentOperation(
      {
        assetId: "fund",
        currency: "EUR",
        executedAt: "2026-06-15",
        feesMinor: 0,
        id: "op2",
        kind: "buy",
        pricePerUnit: "4.25",
        source: "manual",
        units: "50",
      },
      { today: TODAY },
    );

    const built = await buildCorrectionProposal(
      store,
      args({ kind: "edit_identity", providerSymbol: "SAN.MC" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    if (built.proposal.mode !== "solo-desde-hoy") return;
    expect(built.proposal.edits).toEqual([
      {
        after: "SAN.MC",
        before: "—",
        label: "Símbolo de cotización",
        origin: "assistant",
      },
    ]);

    const applied = await confirmCorrectionProposalAction(
      built.proposal.draft,
      store,
      TODAY,
    );
    expect(applied.status).toBe("applied");
    expect(await symbolOf(store, "fund")).toBe("SAN.MC");
    store.close();
  });

  test("refuses to overwrite an ISIN that is already there", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", isin: "IE00B03HCZ61", name: "Vanguard" });

    const built = await buildCorrectionProposal(
      store,
      args({ isin: "IE00B1G3DH73", kind: "edit_identity" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("ficha");
    expect(await isinOf(store, "fund")).toBe("IE00B03HCZ61");
    store.close();
  });

  test("refuses an ISIN another holding already claims, naming it", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Vanguard en MyInvestor" });
    await seedFund(store, {
      id: "other",
      isin: "IE00B03HCZ61",
      name: "Vanguard en Renta 4",
    });

    const built = await buildCorrectionProposal(
      store,
      args({ isin: "IE00B03HCZ61", kind: "edit_identity" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("Vanguard en Renta 4");
    store.close();
  });

  test("refuses a symbol on a value-only opening, with both figures", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Fondo por valor total" });
    await seedValueOnlyOpening(store, "fund", 574_48);

    const built = await buildCorrectionProposal(
      store,
      args({ kind: "edit_identity", providerSymbol: "SAN.MC" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("574,48");
    expect(built.error).toContain("11,90");
    expect(built.error).toContain("SAN.MC");
    expect(await symbolOf(store, "fund")).toBe(null);
    store.close();
  });

  test("a symbol that does not resolve is rejected, nothing persisted", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Fondo" });

    const built = await buildCorrectionProposal(
      store,
      args({ kind: "edit_identity", providerSymbol: "NOPE.XX" }),
      TODAY,
      async () => ({ error: "El símbolo no existe en Yahoo Finance.", ok: false }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("no existe");
    store.close();
  });

  test("the ISIN fill is not offered for a non-investment holding", async () => {
    const store = await seedWorkspace();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 12_000_00,
      id: "car",
      liquidityTier: "illiquid",
      name: "Coche",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
      type: "manual",
    });

    const built = await buildCorrectionProposal(
      store,
      args({ isin: "IE00B03HCZ61", kind: "edit_identity" }, "car"),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("inversión");
    store.close();
  });

  test("the confirm re-resolves against live data: a field filled meanwhile blocks it", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Vanguard" });

    const built = await buildCorrectionProposal(
      store,
      args({ isin: "IE00B03HCZ61", kind: "edit_identity" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Between arming the card and confirming it, the ficha (or a sibling proposal)
    // writes a different ISIN. The draft must not win.
    await store.assets.patchInvestmentIdentity("fund", { isin: "IE00B1G3DH73" });

    const applied = await confirmCorrectionProposalAction(
      built.proposal.draft,
      store,
      TODAY,
    );
    expect(applied.status).toBe("error");
    expect(await isinOf(store, "fund")).toBe("IE00B1G3DH73");
    store.close();
  });

  test("the confirm blocks a key a neighbour claimed meanwhile", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Vanguard en MyInvestor" });
    await seedFund(store, { id: "other", name: "Vanguard en Renta 4" });

    const built = await buildCorrectionProposal(
      store,
      args({ isin: "IE00B03HCZ61", kind: "edit_identity" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    await store.assets.patchInvestmentIdentity("other", { isin: "IE00B03HCZ61" });

    const applied = await confirmCorrectionProposalAction(
      built.proposal.draft,
      store,
      TODAY,
    );
    expect(applied.status).toBe("error");
    expect(await isinOf(store, "fund")).toBe(null);
    store.close();
  });

  test("the chat's store slice carries the ledger the guard needs", async () => {
    // The #1329 guard is fail-closed: without `operations` the fill refuses rather
    // than writing blind, so a forgotten field here would silently disable the
    // whole kind in production while every test kept passing.
    const store = await seedWorkspace();
    try {
      expect(chatToolStores(store).operations).toBeDefined();
    } finally {
      store.close();
    }
  });

  test("the confirm re-checks the #1329 guard: a ledger gone value-only blocks it", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Santander" });
    // A curated ledger at draft time, so the guard lets the card through.
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
    await seedValueOnlyOpening(store, "fund", 574_48);

    const built = await buildCorrectionProposal(
      store,
      args({ kind: "edit_identity", providerSymbol: "SAN.MC" }),
      TODAY,
      RESOLVES,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Then the curated operation is deleted on the ficha, and what remains IS the
    // 1-participación opening: writing the symbol now would hand 574,48 € to one
    // share's quote. The draft carries no lock, so the apply must re-check.
    await store.command.deleteInvestmentOperation({ operationId: "op1", today: TODAY });

    const applied = await confirmCorrectionProposalAction(
      built.proposal.draft,
      store,
      TODAY,
    );
    expect(applied.status).toBe("error");
    expect(await symbolOf(store, "fund")).toBe(null);
    store.close();
  });

  test("without the ledger seam a symbol fill refuses, but an ISIN fill does not", async () => {
    const store = await seedWorkspace();
    await seedFund(store, { id: "fund", name: "Fondo" });

    const built = await buildCorrectionProposal(
      {
        agentView: store.agentView,
        assets: store.assets,
        assistantProposals: store.assistantProposals,
        liabilities: store.liabilities,
      },
      args({ kind: "edit_identity", providerSymbol: "SAN.MC" }),
      TODAY,
      RESOLVES,
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("libro");
    expect(await symbolOf(store, "fund")).toBe(null);

    // The ISIN never reads the ledger, so the same missing seam must not stop it.
    const isinFill = await buildCorrectionProposal(
      {
        agentView: store.agentView,
        assets: store.assets,
        assistantProposals: store.assistantProposals,
        liabilities: store.liabilities,
      },
      args({ isin: "IE00B03HCZ61", kind: "edit_identity" }),
      TODAY,
      RESOLVES,
    );
    expect(isinFill.ok).toBe(true);
    store.close();
  });
});
