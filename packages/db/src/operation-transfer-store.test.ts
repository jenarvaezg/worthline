/**
 * The traspaso survives the round-trip (#1393).
 *
 * The pair's two facts — the id that ties the halves and the acquisition cost the
 * incoming units carry over — only earn their columns if they come back out of the
 * ledger, and if an export → import cannot drop them: that path writes its rows
 * through a different INSERT than `recordInvestmentOperation`, which is exactly how
 * #1401's capture columns nearly went missing.
 */

import { describe, expect, it } from "vitest";

import type { WorthlineStore } from "./index";
import { createInMemoryStore } from "./index";

const TODAY = "2026-08-19";
const MEMBER_ID = "mJ";
const TRANSFER_ID = "trf_1";

const TRANSFER_OUT = {
  assetId: "origen",
  currency: "EUR",
  executedAt: "2026-08-19",
  feesMinor: 0,
  id: "op_out",
  kind: "transfer_out",
  pricePerUnit: "150",
  transferId: TRANSFER_ID,
  units: "5",
} as const;

const TRANSFER_IN = {
  assetId: "destino",
  currency: "EUR",
  executedAt: "2026-08-19",
  feesMinor: 0,
  id: "op_in",
  kind: "transfer_in",
  pricePerUnit: "150",
  transferCostMinor: 50_000,
  transferId: TRANSFER_ID,
  units: "5",
} as const;

async function seed(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Jose" }],
    mode: "individual",
  });
  for (const [id, name] of [
    ["origen", "Fondo de origen"],
    ["destino", "Fondo de destino"],
  ] as const) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id,
      liquidityTier: "market",
      name,
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });
  }
  return store;
}

describe("asset_operations transfer columns", () => {
  it("reads back the pair id and the inherited cost", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(TRANSFER_OUT, { today: TODAY });
    await store.command.recordInvestmentOperation(TRANSFER_IN, { today: TODAY });

    const [out] = await store.operations.readOperations("origen");
    const [incoming] = await store.operations.readOperations("destino");

    expect(out?.transferId).toBe(TRANSFER_ID);
    // Only the incoming half carries a cost: the origin's is derived from its own
    // ledger, so a column there would be a second, drifting copy.
    expect(out?.transferCostMinor).toBeUndefined();
    expect(incoming?.transferId).toBe(TRANSFER_ID);
    expect(incoming?.transferCostMinor).toBe(50_000);
  });

  it("leaves both columns absent on a plain buy", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(
      {
        assetId: "origen",
        currency: "EUR",
        executedAt: "2026-01-01",
        feesMinor: 0,
        id: "op_buy",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    const [operation] = await store.operations.readOperations("origen");

    expect(operation?.transferId).toBeUndefined();
    expect(operation?.transferCostMinor).toBeUndefined();
  });

  it("survives an export → import round-trip", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(TRANSFER_OUT, { today: TODAY });
    await store.command.recordInvestmentOperation(TRANSFER_IN, { today: TODAY });

    const doc = await store.workspace.exportWorkspace();
    const restored = await createInMemoryStore();
    await restored.workspace.importWorkspace(doc);

    const [incoming] = await restored.operations.readOperations("destino");

    expect(incoming?.transferId).toBe(TRANSFER_ID);
    expect(incoming?.transferCostMinor).toBe(50_000);
  });

  it("refuses to overwrite half a pair from a statement merge", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(TRANSFER_OUT, { today: TODAY });

    await expect(
      store.command.mergeInvestmentOperations({
        assetId: "origen",
        creates: [],
        overwrites: [
          {
            currency: "EUR",
            feesMinor: 0,
            id: "op_out",
            kind: "sell",
            pricePerUnit: "150",
            units: "5",
          },
        ],
        today: TODAY,
      }),
    ).rejects.toThrow(/transfer/i);
  });
});

describe("readTransferCounterparts (#1481)", () => {
  it("resuelve la otra mitad del par desde cualquiera de los dos lados", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(TRANSFER_OUT, { today: TODAY });
    await store.command.recordInvestmentOperation(TRANSFER_IN, { today: TODAY });

    const fromOrigin = await store.operations.readTransferCounterparts("origen");
    const fromDestination = await store.operations.readTransferCounterparts("destino");

    expect(fromOrigin.get(TRANSFER_ID)).toEqual({ assetId: "destino" });
    expect(fromDestination.get(TRANSFER_ID)).toEqual({ assetId: "origen" });
  });

  it("la media pareja externa no aparece: sin fila contraparte no hay entrada", async () => {
    const store = await seed();
    // El caso real de producción (#1393): «traer plan desde otra entidad» escribe
    // un transfer_in con transferId propio y ninguna otra fila que lo comparta.
    await store.command.recordInvestmentOperation(
      { ...TRANSFER_IN, id: "op_ext", transferId: "trf_ext" },
      { today: TODAY },
    );

    const counterparts = await store.operations.readTransferCounterparts("destino");

    expect(counterparts.has("trf_ext")).toBe(false);
    expect(counterparts.size).toBe(0);
  });

  it("un libro sin traspasos devuelve el mapa vacío sin consultas de más", async () => {
    const store = await seed();
    await store.command.recordInvestmentOperation(
      {
        assetId: "origen",
        currency: "EUR",
        executedAt: "2026-01-01",
        feesMinor: 0,
        id: "op_buy",
        kind: "buy",
        pricePerUnit: "100",
        units: "10",
      },
      { today: TODAY },
    );

    expect((await store.operations.readTransferCounterparts("origen")).size).toBe(0);
  });
});
