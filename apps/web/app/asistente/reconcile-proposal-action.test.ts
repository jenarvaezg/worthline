import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  confirmReconcileProposalAction,
  discardReconcileProposalAction,
} from "./reconcile-proposal-action";
import type { ReconcileCuration } from "./reconcile-proposal-contract";
import { buildReconcileProposal } from "./reconcile-proposals";

const TODAY = "2026-07-18";
const clock = { today: () => TODAY };
const AMUNDI = "LU1681043599";
const OWNERSHIP = [{ memberId: "m", shareBps: 10_000 }];

async function seedWorkspace(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

function positionsDocument(holdings: unknown[], movements: unknown[] = []) {
  return { documentType: "positions_movements", holdings, movements, warnings: [] };
}

async function draftFrom(
  store: WorthlineStore,
  holdings: unknown[],
  movements: unknown[] = [],
) {
  const built = await buildReconcileProposal(
    store,
    positionsDocument(holdings, movements),
    TODAY,
  );
  if (!built.ok) throw new Error(`build failed: ${built.error}`);
  return built.proposal;
}

describe("confirmReconcileProposalAction (#1108) · dispatch", () => {
  test("create → a new investment asset valued by current state", async () => {
    const store = await seedWorkspace();
    const proposal = await draftFrom(store, [
      {
        name: "Vanguard Global",
        type: "ETF",
        value: 5000,
        currency: "EUR",
        fidelity: "value_only",
      },
    ]);
    const curation: ReconcileCuration[] = [{ decision: "create", rowId: "row-0" }];

    const result = await confirmReconcileProposalAction(
      proposal.draft,
      curation,
      store,
      clock,
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.created).toBe(1);

    const assets = await store.assets.readInvestmentAssetsWithMeta();
    expect(assets).toHaveLength(1);
    expect(await store.operations.readOperations(assets[0]!.id)).toHaveLength(1);
    const persisted = await store.assistantProposals.read(proposal.draft.proposalId);
    expect(persisted?.status).toBe("applied");
    store.close();
  });

  test("update with movements → the movements are appended to the matched holding", async () => {
    const store = await seedWorkspace();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset-amundi",
      instrument: "fund",
      isin: AMUNDI,
      name: "Amundi MSCI World",
      ownership: OWNERSHIP,
    });
    const proposal = await draftFrom(
      store,
      [
        {
          name: "Amundi MSCI World",
          type: "Fondo",
          isin: AMUNDI,
          value: 12000,
          currency: "EUR",
          fidelity: "movements",
        },
      ],
      [
        {
          date: "2025-01-10",
          kind: "buy",
          isin: AMUNDI,
          units: 100,
          amount: 6000,
          currency: "EUR",
        },
        {
          date: "2025-06-10",
          kind: "buy",
          isin: AMUNDI,
          units: 100,
          amount: 6000,
          currency: "EUR",
        },
      ],
    );
    const curation: ReconcileCuration[] = [
      { decision: "update", rowId: "row-0", target: "asset-amundi" },
    ];

    const result = await confirmReconcileProposalAction(
      proposal.draft,
      curation,
      store,
      clock,
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.updated).toBe(1);
    expect(await store.operations.readOperations("asset-amundi")).toHaveLength(2);
    store.close();
  });

  test("value-only update on a matched holding writes nothing (honest leave)", async () => {
    const store = await seedWorkspace();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset-amundi",
      instrument: "fund",
      isin: AMUNDI,
      name: "Amundi MSCI World",
      ownership: OWNERSHIP,
    });
    const proposal = await draftFrom(store, [
      {
        name: "Amundi MSCI World",
        type: "Fondo",
        isin: AMUNDI,
        value: 12000,
        currency: "EUR",
        fidelity: "value_only",
      },
      // a second create so the proposal has something writable to exist at all
      {
        name: "New ETF",
        type: "ETF",
        value: 5000,
        currency: "EUR",
        fidelity: "value_only",
      },
    ]);
    const curation: ReconcileCuration[] = [
      { decision: "update", rowId: "row-0", target: "asset-amundi" },
      { decision: "leave", rowId: "row-1" },
    ];

    const result = await confirmReconcileProposalAction(
      proposal.draft,
      curation,
      store,
      clock,
    );
    // Nothing writable → honest error, no operations added to the matched holding.
    expect(result.status).toBe("error");
    expect(await store.operations.readOperations("asset-amundi")).toHaveLength(0);
    const persisted = await store.assistantProposals.read(proposal.draft.proposalId);
    expect(persisted?.status).toBe("draft");
    store.close();
  });

  test("a curated update to a non-candidate holding is rejected at confirm (drift safety)", async () => {
    const store = await seedWorkspace();
    // An unrelated investment asset the row-0 create never proposed as a candidate.
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset-unrelated",
      instrument: "fund",
      name: "Otro fondo",
      ownership: OWNERSHIP,
    });
    const proposal = await draftFrom(
      store,
      [
        {
          name: "Vanguard Global",
          type: "ETF",
          value: 5000,
          currency: "EUR",
          fidelity: "movements",
        },
      ],
      [
        {
          date: "2025-01-10",
          kind: "buy",
          name: "Vanguard Global",
          units: 10,
          amount: 5000,
          currency: "EUR",
        },
      ],
    );
    // The client curates row-0 as an update to a holding that was never a candidate.
    const curation: ReconcileCuration[] = [
      { decision: "update", rowId: "row-0", target: "asset-unrelated" },
    ];

    const result = await confirmReconcileProposalAction(
      proposal.draft,
      curation,
      store,
      clock,
    );
    expect(result.status).toBe("error");
    // Nothing was written to the unrelated holding.
    expect(await store.operations.readOperations("asset-unrelated")).toHaveLength(0);
    const persisted = await store.assistantProposals.read(proposal.draft.proposalId);
    expect(persisted?.status).toBe("draft");
    store.close();
  });

  test("discard resolves the proposal without writing", async () => {
    const store = await seedWorkspace();
    const proposal = await draftFrom(store, [
      {
        name: "Vanguard Global",
        type: "ETF",
        value: 5000,
        currency: "EUR",
        fidelity: "value_only",
      },
    ]);
    const result = await discardReconcileProposalAction(proposal.draft, store);
    expect(result.status).toBe("discarded");
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(0);
    store.close();
  });
});

describe("confirmReconcileProposalAction (#1108) · atomicity (todo o nada)", () => {
  test("a write that fails midway rolls the whole batch back and nothing persists", async () => {
    const store = await seedWorkspace();
    const proposal = await store.assistantProposals.create({ kind: "reconcile" });

    // Two created holdings whose operations collide on the same id: the first
    // asset is created, then the duplicate operation id violates the primary key
    // mid-transaction. The single statement-import transaction must roll the whole
    // batch back — neither asset nor either operation may survive.
    const op = (assetId: string) => ({
      assetId,
      currency: "EUR" as const,
      executedAt: TODAY,
      feesMinor: 0,
      id: "op-collision",
      kind: "buy" as const,
      pricePerUnit: "100",
      source: "agent" as const,
      units: "1",
    });

    await expect(
      store.command.applyAssistantReconcileProposal({
        funds: [
          {
            asset: {
              currency: "EUR",
              id: "asset-a",
              instrument: "fund",
              name: "A",
              ownership: OWNERSHIP,
            },
            creates: [op("asset-a")],
            kind: "new",
          },
          {
            asset: {
              currency: "EUR",
              id: "asset-b",
              instrument: "fund",
              name: "B",
              ownership: OWNERSHIP,
            },
            creates: [op("asset-b")],
            kind: "new",
          },
        ],
        proposalId: proposal.id,
        today: TODAY,
      }),
    ).rejects.toThrow();

    // Rollback: no assets, no operations, and the proposal is STILL a draft, so it
    // survives for a retry (decision #1090).
    expect(await store.assets.readInvestmentAssetsWithMeta()).toHaveLength(0);
    expect(await store.operations.readOperations("asset-a")).toHaveLength(0);
    const persisted = await store.assistantProposals.read(proposal.id);
    expect(persisted?.status).toBe("draft");
    store.close();
  });
});
