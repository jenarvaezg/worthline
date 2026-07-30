/**
 * Procedencia on the holding row (uso real 2026-07-30).
 *
 * Reproduced from a real free-tier transcript: the user asked to update his coin
 * collection, the context DID carry a `connectedSources` block naming it, and the
 * model still answered «este activo no se actualiza automáticamente» and prepared a
 * hand-declared value. Joining two blocks is not something a small model does — so
 * the mark rides on the row it describes.
 */

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test } from "vitest";

import { connectedSourceByAssetId } from "./connected-source-provenance";
import { buildFinancialContext } from "./financial-context";
import { bindScope } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";

const AS_OF = "2026-07-30";
const SOLO = [{ memberId: "m", shareBps: 10_000 }];

const openStores = new Set<WorthlineStore>();
afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
});

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  openStores.add(store);
  await store.workspace.initializeWorkspace({
    members: [{ id: "m", name: "Titular" }],
    mode: "individual",
  });
  return store;
}

async function defaultScopeContext(store: WorthlineStore) {
  const scopes = await listAgentViewScopes(store.agentView);
  const scopeId = (scopes.find((scope) => scope.isDefault) ?? scopes[0])?.id ?? "";
  return buildFinancialContext(bindScope(store.agentView, scopeId), { asOf: AS_OF });
}

describe("connectedSourceByAssetId", () => {
  test("indexes every rung a source materializes, and nothing else", () => {
    const byAssetId = connectedSourceByAssetId([
      {
        adapter: "binance",
        assetId: "a-market",
        assetIds: ["a-market", "a-term"],
        id: "src-1",
        label: "Binance principal",
        lastSyncAt: null,
      },
      {
        adapter: "numista",
        assetId: "a-coins",
        assetIds: ["a-coins"],
        id: "src-2",
        label: "Colección de monedas",
        lastSyncAt: null,
      },
    ]);

    expect(byAssetId.get("a-term")).toEqual({
      adapter: "binance",
      label: "Binance principal",
    });
    expect(byAssetId.get("a-coins")).toEqual({
      adapter: "numista",
      label: "Colección de monedas",
    });
    expect(byAssetId.has("a-manual")).toBe(false);
  });
});

describe("buildFinancialContext · procedencia per holding (uso real 2026-07-30)", () => {
  test("stamps connectedSource on the sync-owned row and leaves manual rows unmarked", async () => {
    const store = await seed();
    const { assetId } = await store.connectedSources.connect({
      adapter: "numista",
      credentialsJson: JSON.stringify({ apiKey: "test-key" }),
      label: "Colección de monedas",
      ownership: SOLO,
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "manual-cash",
      instrument: "current_account",
      liquidityTier: "cash",
      name: "Cuenta corriente",
      ownership: SOLO,
      type: "cash",
    });

    const context = await defaultScopeContext(store);
    const publicIds = await store.agentView.readPublicIds();
    const publicIdOf = (internalId: string) =>
      publicIds.find((row) => row.entityType === "holding" && row.entityId === internalId)
        ?.publicId;

    const projected = context.holdings.items.find(
      (holding) => holding.id === publicIdOf(assetId),
    );
    const manual = context.holdings.items.find(
      (holding) => holding.id === publicIdOf("manual-cash"),
    );

    expect(projected?.connectedSource).toEqual({
      adapter: "numista",
      label: "Colección de monedas",
    });
    // Absent, not null: a hand-maintained holding carries no mark at all.
    expect(manual).toBeDefined();
    expect(manual && "connectedSource" in manual).toBe(false);
  });

  test("the marked rows and the connectedSources block name the same holdings", async () => {
    const store = await seed();
    await store.connectedSources.connect({
      adapter: "numista",
      credentialsJson: JSON.stringify({ apiKey: "test-key" }),
      label: "Colección de monedas",
      ownership: SOLO,
    });

    const context = await defaultScopeContext(store);

    // Both derive from the SAME `readConnectedSources()` result, so the row-level
    // mark and the block can never disagree about who owns a holding's value.
    const marked = context.holdings.items.filter((holding) => holding.connectedSource);
    expect(marked).toHaveLength(1);
    expect(context.connectedSources[0]?.projectedHoldings.map((h) => h.id)).toEqual(
      marked.map((holding) => holding.id),
    );
  });
});
