import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import { transferCounterpartByOperationId } from "./transfer-counterparts";

function operation(over: Partial<InvestmentOperation>): InvestmentOperation {
  return {
    assetId: "origen",
    currency: "EUR",
    executedAt: "2026-08-19",
    feesMinor: 0,
    id: "op_1",
    kind: "buy",
    pricePerUnit: "100",
    units: "1",
    ...over,
  };
}

describe("transferCounterpartByOperationId (#1481)", () => {
  const names = new Map([
    ["origen", "Fondo Rojo"],
    ["destino", "Fondo Azul"],
  ]);

  test("una mitad emparejada resuelve el nombre de su contraparte", () => {
    const result = transferCounterpartByOperationId(
      [operation({ id: "op_out", kind: "transfer_out", transferId: "trf_1" })],
      new Map([["trf_1", { assetId: "destino" }]]),
      names,
    );

    expect(result).toEqual({
      op_out: { kind: "holding", name: "Fondo Azul" },
    });
  });

  test("sin fila contraparte en el workspace, la mitad es externa", () => {
    const result = transferCounterpartByOperationId(
      [operation({ id: "op_ext", kind: "transfer_in", transferId: "trf_ext" })],
      new Map(),
      names,
    );

    expect(result).toEqual({ op_ext: { kind: "external" } });
  });

  test("una contraparte sin nombre (papelera) queda como irresoluble, no como externa", () => {
    const result = transferCounterpartByOperationId(
      [operation({ id: "op_out", kind: "transfer_out", transferId: "trf_1" })],
      new Map([["trf_1", { assetId: "borrado" }]]),
      names,
    );

    expect(result).toEqual({ op_out: { kind: "unresolved" } });
  });

  test("las compras y ventas no reciben entrada", () => {
    const result = transferCounterpartByOperationId(
      [operation({ id: "op_buy", kind: "buy" })],
      new Map(),
      names,
    );

    expect(result).toEqual({});
  });
});
