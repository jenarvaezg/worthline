/**
 * The delete button of the operations table, pointed at half a traspaso (#1479).
 *
 * Why this suite exists. The traspaso gate writes two rows in two holdings, and the
 * operations table renders each of them as a line with its own «Eliminar». Deleting
 * one would leave the other claiming to be one movement with a row that no longer
 * exists — and, on the destination, an inherited cost with nothing that explains it.
 * The store REFUSES that delete (loudly, so no other writer can do it by accident),
 * which means the action has to recognize the half and remove the pair instead.
 *
 * Real in-memory store, next/cache stubbed — the same shape as the other operations
 * wiring suites.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

import { deleteOperationAction } from "@web/inversiones/operation-actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { catchRedirect, fd } from "./helpers";

const MEMBER_ID = "member_yo";
const ORIGIN = "asset_origen";
const DESTINATION = "asset_destino";
const DETAIL_URL = `/patrimonio/${ORIGIN}/editar`;
const TODAY = "2026-08-19";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

async function setupTransfer(): Promise<WorthlineStore> {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Yo" }],
    mode: "individual",
  });
  for (const [id, name] of [
    [ORIGIN, "Fondo de origen"],
    [DESTINATION, "Fondo de destino"],
  ] as const) {
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id,
      liquidityTier: "market",
      manualPricePerUnit: "100",
      name,
      ownership: [{ memberId: MEMBER_ID, shareBps: 10_000 }],
    });
  }
  await store.command.recordInvestmentOperation(
    {
      assetId: ORIGIN,
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_compra",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    },
    { today: TODAY },
  );
  const written = await store.command.recordInvestmentTransfer({
    destinationAssetId: DESTINATION,
    destinationPricePerUnit: "50",
    executedAt: "2026-06-15",
    inOperationId: "op_in",
    originAssetId: ORIGIN,
    originPricePerUnit: "120",
    outOperationId: "op_out",
    portion: { kind: "all" },
    today: TODAY,
    transferId: "trf_1",
  });
  expect(written.ok).toBe(true);
  return store;
}

describe("deleteOperationAction — half a traspaso deletes the whole traspaso", () => {
  test("deleting the outgoing half removes the incoming one too", async () => {
    await setupTransfer();

    const url = await catchRedirect(() =>
      deleteOperationAction(ORIGIN, fd({ operationId: "op_out" }, DETAIL_URL), store),
    );

    expect(url).toContain("ok=operation_deleted");
    expect((await store.operations.readOperations(ORIGIN)).map((op) => op.id)).toEqual([
      "op_compra",
    ]);
    expect(await store.operations.readOperations(DESTINATION)).toEqual([]);
  });

  test("deleting the INCOMING half, from the destination's own page, does the same", async () => {
    await setupTransfer();

    // The destination is where the user lands after the traspaso, so its table is the
    // likelier place for the click. Both ends have to behave the same.
    const url = await catchRedirect(() =>
      deleteOperationAction(
        DESTINATION,
        fd({ operationId: "op_in" }, `/patrimonio/${DESTINATION}/editar`),
        store,
      ),
    );

    expect(url).toContain("ok=operation_deleted");
    expect(await store.operations.readOperations(DESTINATION)).toEqual([]);
    expect((await store.operations.readOperations(ORIGIN)).map((op) => op.id)).toEqual([
      "op_compra",
    ]);
  });

  test("an ordinary operation on the same holding is still deleted alone", async () => {
    await setupTransfer();

    const url = await catchRedirect(() =>
      deleteOperationAction(ORIGIN, fd({ operationId: "op_compra" }, DETAIL_URL), store),
    );

    expect(url).toContain("ok=operation_deleted");
    // The traspaso survives: recognizing a half must not turn every delete into a
    // pair delete.
    expect((await store.operations.readOperations(ORIGIN)).map((op) => op.id)).toEqual([
      "op_out",
    ]);
    expect(
      (await store.operations.readOperations(DESTINATION)).map((op) => op.id),
    ).toEqual(["op_in"]);
  });
});
