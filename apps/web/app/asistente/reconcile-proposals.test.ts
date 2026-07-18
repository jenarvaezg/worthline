import {
  type ConnectedSourceRow,
  createInMemoryStore,
  type WorthlineStore,
} from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  buildReconcileProposal,
  connectedReconcileAssetIds,
} from "./reconcile-proposals";

/** A stub connected-source store reporting a fixed set of source-owned asset ids. */
function connectedSourcesStub(assetIdsBySource: Record<string, string[]>) {
  return {
    listSources: async () =>
      Object.keys(assetIdsBySource).map((id) => ({ id }) as ConnectedSourceRow),
    listSourceAssetIds: async (sourceId: string) => assetIdsBySource[sourceId] ?? [],
  };
}

const TODAY = "2026-07-18";
const AMUNDI = "LU1681043599";

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

describe("buildReconcileProposal (#1108)", () => {
  test("rejects a malformed document at the trust boundary", async () => {
    const store = await seedWorkspace();
    const built = await buildReconcileProposal(store, { nope: true }, TODAY);
    expect(built.ok).toBe(false);
    store.close();
  });

  test("matches by ISIN → update, and a miss → create, and persists the proposal", async () => {
    const store = await seedWorkspace();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset-amundi",
      instrument: "fund",
      isin: AMUNDI,
      name: "Amundi MSCI World",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });

    const built = await buildReconcileProposal(
      store,
      positionsDocument(
        [
          {
            name: "Amundi MSCI World",
            type: "Fondo",
            isin: AMUNDI,
            value: 12000,
            currency: "EUR",
            fidelity: "movements",
          },
          {
            name: "Vanguard Global",
            type: "ETF",
            value: 5000,
            currency: "EUR",
            fidelity: "value_only",
          },
        ],
        [
          {
            date: "2025-01-10",
            kind: "buy",
            isin: AMUNDI,
            amount: 12000,
            currency: "EUR",
          },
        ],
      ),
      TODAY,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.proposalType).toBe("reconcile");
    expect(built.proposal.rows).toHaveLength(2);
    expect(built.proposal.rows[0]!.match.decision).toBe("update");
    expect(built.proposal.rows[0]!.match.target).toBe("asset-amundi");
    expect(built.proposal.rows[1]!.match.decision).toBe("create");

    // The proposal is persisted as a draft carrying the document fact.
    const persisted = await store.assistantProposals.read(
      built.proposal.draft.proposalId,
    );
    expect(persisted?.kind).toBe("reconcile");
    expect(persisted?.status).toBe("draft");
    const fact = persisted?.documents.flatMap((d) => d.facts)[0];
    expect(fact?.kind).toBe("holding_reconcile");
    store.close();
  });

  test("connectedReconcileAssetIds unions every source's asset ids", async () => {
    const ids = await connectedReconcileAssetIds(
      connectedSourcesStub({ s1: ["a1"], s2: ["a2", "a3"] }),
    );
    expect(ids).toEqual(new Set(["a1", "a2", "a3"]));
    expect(await connectedReconcileAssetIds(undefined)).toEqual(new Set());
  });

  test("a connected-source holding is fenced off — its match becomes a create, not an update", async () => {
    const store = await seedWorkspace();
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset-amundi",
      instrument: "fund",
      isin: AMUNDI,
      name: "Amundi MSCI World",
      ownership: [{ memberId: "m", shareBps: 10_000 }],
    });

    const built = await buildReconcileProposal(
      {
        agentView: store.agentView,
        assets: store.assets,
        assistantProposals: store.assistantProposals,
        connectedSources: connectedSourcesStub({ binance: ["asset-amundi"] }),
        liabilities: store.liabilities,
        workspace: store.workspace,
      },
      positionsDocument([
        {
          name: "Amundi MSCI World",
          type: "Fondo",
          isin: AMUNDI,
          value: 12000,
          currency: "EUR",
          fidelity: "value_only",
        },
      ]),
      TODAY,
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // The sync-owned holding is not a candidate, so the row creates rather than
    // proposing an update to the connected holding (the "no escribas a fuente
    // conectada" boundary, enforced in code).
    expect(built.proposal.rows[0]!.match.decision).toBe("create");
    expect(built.proposal.rows[0]!.match.candidates).toHaveLength(0);
    store.close();
  });

  test("rejects a document that writes nothing (all out of scope)", async () => {
    const store = await seedWorkspace();
    const built = await buildReconcileProposal(
      store,
      positionsDocument([
        {
          name: "Casa",
          type: "Inmueble",
          value: 100,
          currency: "EUR",
          fidelity: "value_only",
        },
      ]),
      TODAY,
    );
    expect(built.ok).toBe(false);
    store.close();
  });
});
