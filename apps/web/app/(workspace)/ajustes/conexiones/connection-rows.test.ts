import type { SourcePosition } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";
import {
  type ConnectionDataDefinition,
  type ConnectionSourceRow,
  loadConnectionRows,
} from "./connection-rows";

/** Un adapter cuyo valor es el del activo espejo (la forma de Numista). */
const mirrorAdapter: ConnectionDataDefinition = {
  adapter: "espejo",
  countUnits: (positions) => positions.length,
  valueMinor: ({ assets, primaryAssetId }) =>
    assets.find((asset) => asset.id === primaryAssetId)?.currentValue.amountMinor ?? 0,
};

/** Un adapter que ocupa varios peldaños y suma sus activos (la forma de Binance). */
const rungsAdapter: ConnectionDataDefinition = {
  adapter: "peldanos",
  countUnits: (positions) => positions.length,
  valueMinor: ({ assets, sourceAssetIds }) =>
    assets
      .filter((asset) => sourceAssetIds.includes(asset.id))
      .reduce((sum, asset) => sum + asset.currentValue.amountMinor, 0),
};

function sourceRow(overrides: Partial<ConnectionSourceRow> = {}): ConnectionSourceRow {
  return {
    adapter: "espejo",
    assetId: "asset_espejo",
    id: "src_espejo",
    lastSyncAt: "2026-08-16T05:12:41.000Z",
    ...overrides,
  };
}

function position(externalId: string): SourcePosition {
  return {
    kind: "token",
    id: externalId,
    sourceId: "src",
    externalId,
    name: externalId,
    liquidityTier: "market",
    currency: "EUR",
    symbol: externalId,
    balance: "1",
    wallet: "spot",
    unitPrice: "1",
    imageUrl: null,
  };
}

function fakeStore(
  positions: Record<string, SourcePosition[]> = {},
  assetIds: Record<string, string[]> = {},
) {
  return {
    listSourceAssetIds: vi.fn(async (sourceId: string) => assetIds[sourceId] ?? []),
    readPositions: vi.fn(async (sourceId: string) => positions[sourceId] ?? []),
  };
}

describe("loadConnectionRows (#1223)", () => {
  test("a connected source becomes a row with its adapter's own count and value", async () => {
    const store = fakeStore({ src_espejo: [position("a"), position("b")] });

    const rows = await loadConnectionRows({
      assets: [
        { id: "asset_espejo", currentValue: { amountMinor: 1_824_050 } },
        { id: "asset_otro", currentValue: { amountMinor: 999 } },
      ],
      definitions: [mirrorAdapter],
      hrefOf: () => "/patrimonio/wl_hld_1",
      sources: [sourceRow()],
      store,
    });

    expect(rows).toEqual([
      {
        adapter: "espejo",
        fichaHref: "/patrimonio/wl_hld_1",
        source: {
          assetId: "asset_espejo",
          id: "src_espejo",
          lastSyncAt: "2026-08-16T05:12:41.000Z",
        },
        unitCount: 2,
        valueMinor: 1_824_050,
      },
    ]);
  });

  test("a source spanning several rungs values ALL of its assets, not just the mirror", async () => {
    const store = fakeStore(
      { src_peldanos: [position("a")] },
      { src_peldanos: ["asset_market", "asset_plazo"] },
    );

    const rows = await loadConnectionRows({
      assets: [
        { id: "asset_market", currentValue: { amountMinor: 400_000 } },
        { id: "asset_plazo", currentValue: { amountMinor: 81_233 } },
        { id: "asset_ajeno", currentValue: { amountMinor: 500_000 } },
      ],
      definitions: [rungsAdapter],
      hrefOf: () => null,
      sources: [
        sourceRow({ adapter: "peldanos", assetId: "asset_market", id: "src_peldanos" }),
      ],
      store,
    });

    expect(rows[0]?.valueMinor).toBe(481_233);
  });

  test("an adapter with no connected source is a row too — the page offers connecting it", async () => {
    const store = fakeStore();

    const rows = await loadConnectionRows({
      assets: [],
      definitions: [mirrorAdapter],
      hrefOf: () => "/patrimonio/wl_hld_1",
      sources: [],
      store,
    });

    expect(rows).toEqual([
      {
        adapter: "espejo",
        fichaHref: null,
        source: null,
        unitCount: 0,
        valueMinor: 0,
      },
    ]);
    // Sin fuente no hay nada que leer: la página no paga I/O por un adapter suelto.
    expect(store.readPositions).not.toHaveBeenCalled();
    expect(store.listSourceAssetIds).not.toHaveBeenCalled();
  });

  test("rows follow the registry order, not the order the store lists sources in", async () => {
    const store = fakeStore();

    const rows = await loadConnectionRows({
      assets: [],
      definitions: [mirrorAdapter, rungsAdapter],
      hrefOf: () => null,
      sources: [
        sourceRow({ adapter: "peldanos", assetId: "asset_market", id: "src_peldanos" }),
        sourceRow(),
      ],
      store,
    });

    expect(rows.map((row) => row.adapter)).toEqual(["espejo", "peldanos"]);
  });

  test("a mirrored holding with no public id loses its link, not its row (#1318)", async () => {
    const store = fakeStore({ src_espejo: [position("a")] });

    const rows = await loadConnectionRows({
      assets: [{ id: "asset_espejo", currentValue: { amountMinor: 10_000 } }],
      definitions: [mirrorAdapter],
      hrefOf: () => null,
      sources: [sourceRow()],
      store,
    });

    expect(rows[0]?.fichaHref).toBeNull();
    expect(rows[0]?.unitCount).toBe(1);
  });

  test("a source whose adapter is not in the registry is ignored", async () => {
    const store = fakeStore({ src_desconocido: [position("a")] });

    const rows = await loadConnectionRows({
      assets: [],
      definitions: [mirrorAdapter],
      hrefOf: () => null,
      sources: [
        sourceRow({ adapter: "adapter_retirado", id: "src_desconocido" }),
        sourceRow(),
      ],
      store,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.adapter).toBe("espejo");
  });
});
