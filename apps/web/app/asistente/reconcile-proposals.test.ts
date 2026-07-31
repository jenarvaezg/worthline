import type { ConnectedSourceRow } from "@worthline/db";
// The persistence escape hatch: seeding a CLOSED position needs `recordOperation`,
// which the narrowed application store does not expose.
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
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

  /**
   * The same fund at two brokers (#1331), as it really is in the father's workspace:
   * IE00B1G3DH73 lives in a CLOSED position of an old portfolio (bought and sold in
   * full) and in the LIVE holding of the Cartera Indexada that keeps receiving
   * contributions. First-wins matched the closed one at `strong` confidence and the
   * new contributions would have been applied there, unattended and unsignalled.
   */
  describe("el mismo ISIN en dos holdings (#1331)", () => {
    const SHARED = "IE00B1G3DH73";

    async function seedBothBrokers(): Promise<WorthlineStore> {
      const store = await seedWorkspace();
      // The old broker's position, created FIRST (so first-wins would pick it) and
      // sold in full → zero units, zero value: closed.
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "asset-closed",
        instrument: "fund",
        isin: SHARED,
        name: "Vanguard U.S. 500 Stk Idx € H Acc",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
      });
      await store.operations.recordOperation({
        assetId: "asset-closed",
        currency: "EUR",
        executedAt: "2021-03-01",
        feesMinor: 0,
        id: "op-closed-buy",
        kind: "buy",
        pricePerUnit: "100",
        units: "97.65",
      });
      await store.operations.recordOperation({
        assetId: "asset-closed",
        currency: "EUR",
        executedAt: "2023-09-01",
        feesMinor: 0,
        id: "op-closed-sell",
        kind: "sell",
        pricePerUnit: "120",
        units: "97.65",
      });
      // The live Cartera Indexada holding.
      await store.assets.createInvestmentAsset({
        currency: "EUR",
        id: "asset-live",
        instrument: "fund",
        isin: SHARED,
        name: "Vanguard US Equity Index Fund EUR Hedged",
        ownership: [{ memberId: "m", shareBps: 10_000 }],
      });
      await store.operations.recordOperation({
        assetId: "asset-live",
        currency: "EUR",
        executedAt: "2025-01-15",
        feesMinor: 0,
        id: "op-live-buy",
        kind: "buy",
        pricePerUnit: "150",
        units: "40",
      });
      return store;
    }

    function contributionDocument(name: string) {
      return positionsDocument(
        [
          {
            name,
            type: "Fondo",
            isin: SHARED,
            value: 6000,
            currency: "EUR",
            fidelity: "movements",
          },
        ],
        [
          {
            date: "2026-06-10",
            kind: "buy",
            isin: SHARED,
            units: 4,
            amount: 600,
            currency: "EUR",
          },
        ],
      );
    }

    test("the shared ISIN is never strong: the preview offers both holdings for review", async () => {
      const store = await seedBothBrokers();
      const built = await buildReconcileProposal(
        store,
        contributionDocument("Vanguard US Equity Index Fund EUR Hedged"),
        TODAY,
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const [row] = built.proposal.rows;
      expect(row!.match.confidence).toBe("weak");
      expect(row!.match.ambiguous).toBe(true);
      expect(row!.match.candidates.map((candidate) => candidate.holdingId)).toEqual([
        "asset-live",
        "asset-closed",
      ]);
      store.close();
    });

    test("a sold-out position no longer wins by being first: the default is the live holding", async () => {
      const store = await seedBothBrokers();
      // A name that matches NEITHER holding, so only the closed/live signal can rank
      // them — the projection's zero-value → `closed` mark carries the decision.
      const built = await buildReconcileProposal(
        store,
        contributionDocument("VANGUARD US 500 STK IDX"),
        TODAY,
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.proposal.rows[0]!.match.target).toBe("asset-live");
      store.close();
    });
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
