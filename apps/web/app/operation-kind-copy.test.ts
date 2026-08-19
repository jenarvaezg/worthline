import type { OperationKind } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import { operationKindLabel } from "./operation-kind-copy";

describe("operationKindLabel (#1393)", () => {
  test("cada mitad del traspaso se nombra por lo que es, no como compraventa", () => {
    expect(operationKindLabel("transfer_out")).toBe("Traspaso (salida)");
    expect(operationKindLabel("transfer_in")).toBe("Traspaso (entrada)");
  });

  test("la compra y la venta conservan su palabra de siempre", () => {
    expect(operationKindLabel("buy")).toBe("Compra");
    expect(operationKindLabel("sell")).toBe("Venta");
  });

  test("los cuatro tipos del libro tienen nombre", () => {
    const kinds: OperationKind[] = ["buy", "sell", "transfer_in", "transfer_out"];
    for (const kind of kinds) {
      expect(operationKindLabel(kind)).not.toBe("");
    }
  });
});
