import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import { signedInvestedMinor } from "./operation-flow";

function op(
  kind: InvestmentOperation["kind"],
  extra: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId: "asset",
    currency: "EUR",
    executedAt: "2026-08-19",
    feesMinor: 0,
    id: `op_${kind}`,
    kind,
    pricePerUnit: "100",
    units: "10",
    ...extra,
  };
}

describe("signedInvestedMinor", () => {
  test("una compra capitaliza sus comisiones y una venta las neta", () => {
    expect(signedInvestedMinor(op("buy", { feesMinor: 500 }), "flow")).toBe(100_500);
    expect(signedInvestedMinor(op("sell", { feesMinor: 500 }), "flow")).toBe(-99_500);
  });

  test("con la política `flow` el traspaso es el movimiento de capital que es", () => {
    expect(signedInvestedMinor(op("transfer_in", { transferId: "t" }), "flow")).toBe(
      100_000,
    );
    expect(signedInvestedMinor(op("transfer_out", { transferId: "t" }), "flow")).toBe(
      -100_000,
    );
  });

  test("con la política `zero` el traspaso es un no-evento", () => {
    expect(signedInvestedMinor(op("transfer_in", { transferId: "t" }), "zero")).toBe(0);
    expect(signedInvestedMinor(op("transfer_out", { transferId: "t" }), "zero")).toBe(0);
  });

  test("el par se anula bajo `flow`: junto no movió nada", () => {
    const out = signedInvestedMinor(op("transfer_out", { transferId: "t" }), "flow");
    const incoming = signedInvestedMinor(op("transfer_in", { transferId: "t" }), "flow");

    expect(out + incoming).toBe(0);
  });
});
