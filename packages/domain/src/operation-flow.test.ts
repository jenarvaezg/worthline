import { describe, expect, test } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import {
  isDeclaredOpening,
  operationAmountFromGrossMinor,
  operationAmountMinor,
  operationGrossFromAmountMinor,
  signedInvestedMinor,
} from "./operation-flow";

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

describe("operationAmountMinor: el importe de un apunte en el libro (#1827)", () => {
  test("una compra cuesta participaciones × precio MÁS la comisión", () => {
    // 5 × 106,65 € + 1 € de comisión = 534,25 €.
    expect(
      operationAmountMinor(
        op("buy", { feesMinor: 100, pricePerUnit: "106.65", units: "5" }),
      ),
    ).toBe(53_425);
  });

  test("una venta devuelve participaciones × precio MENOS la comisión", () => {
    // 5 × 106,65 € − 1 € = 532,25 €.
    expect(
      operationAmountMinor(
        op("sell", { feesMinor: 100, pricePerUnit: "106.65", units: "5" }),
      ),
    ).toBe(53_225);
  });

  test("la entrada de un traspaso capitaliza su comisión, como una compra", () => {
    // La comisión del traspaso vive en la mitad de entrada (#1393): 5 × 150 € + 2 €.
    expect(
      operationAmountMinor(
        op("transfer_in", {
          feesMinor: 200,
          pricePerUnit: "150",
          transferId: "t",
          units: "5",
        }),
      ),
    ).toBe(75_200);
  });

  test("la salida de un traspaso es lo que salió a su valor de ese día", () => {
    expect(
      operationAmountMinor(
        op("transfer_out", { pricePerUnit: "150", transferId: "t", units: "5" }),
      ),
    ).toBe(75_000);
  });

  test("redondea al céntimo a la mitad hacia arriba, sin la deriva de un Number", () => {
    // 1 × 1,005 € = 1,005 € → 1,01 €. Con Number, 1.005 × 100 = 100.49999… → 1,00 €.
    expect(operationAmountMinor(op("buy", { pricePerUnit: "1.005", units: "1" }))).toBe(
      101,
    );
    // Un VL con 20 decimales que dejó una conversión (#1467): 6 × 52,0916… = 312,55 €.
    expect(
      operationAmountMinor(
        op("buy", { pricePerUnit: "52.09166666666666667", units: "6" }),
      ),
    ).toBe(31_255);
  });

  test("una venta que cobra más comisión de lo que ingresa no se disfraza de cobro", () => {
    // 0,001 × 100 € = 0,10 €, menos 1 € de comisión: la venta costó 0,90 €.
    expect(
      operationAmountMinor(
        op("sell", { feesMinor: 100, pricePerUnit: "100", units: "0.001" }),
      ),
    ).toBe(-90);
  });
});

describe("bruto ↔ importe: la misma tabla de signos en las dos direcciones (#1836)", () => {
  test("una venta de 995 € con 5 € de comisión salió de un bruto de 1.000 €", () => {
    expect(
      operationGrossFromAmountMinor({
        amountMinor: 99_500,
        feesMinor: 500,
        kind: "sell",
      }),
    ).toBe(100_000);
    expect(
      operationAmountFromGrossMinor({
        feesMinor: 500,
        grossMinor: 100_000,
        kind: "sell",
      }),
    ).toBe(99_500);
  });

  test("una compra de 1.005 € con 5 € de comisión compró un bruto de 1.000 €", () => {
    expect(
      operationGrossFromAmountMinor({
        amountMinor: 100_500,
        feesMinor: 500,
        kind: "buy",
      }),
    ).toBe(100_000);
    expect(
      operationAmountFromGrossMinor({ feesMinor: 500, grossMinor: 100_000, kind: "buy" }),
    ).toBe(100_500);
  });

  test("la entrada de un traspaso capitaliza su comisión, como una compra", () => {
    expect(
      operationGrossFromAmountMinor({
        amountMinor: 75_200,
        feesMinor: 200,
        kind: "transfer_in",
      }),
    ).toBe(75_000);
  });

  test("la salida de un traspaso sin comisión es la identidad", () => {
    expect(
      operationGrossFromAmountMinor({
        amountMinor: 75_000,
        feesMinor: 0,
        kind: "transfer_out",
      }),
    ).toBe(75_000);
    expect(
      operationAmountFromGrossMinor({
        feesMinor: 0,
        grossMinor: 75_000,
        kind: "transfer_out",
      }),
    ).toBe(75_000);
  });

  test("ida y vuelta en los cuatro tipos", () => {
    for (const kind of ["buy", "sell", "transfer_in", "transfer_out"] as const) {
      const grossMinor = operationGrossFromAmountMinor({
        amountMinor: 123_456,
        feesMinor: 789,
        kind,
      });
      expect(operationAmountFromGrossMinor({ feesMinor: 789, grossMinor, kind })).toBe(
        123_456,
      );
    }
  });

  test("el importe del libro es el del bruto de participaciones × precio", () => {
    const sell = op("sell", { feesMinor: 500, pricePerUnit: "100", units: "10" });
    expect(operationAmountMinor(sell)).toBe(
      operationAmountFromGrossMinor({
        feesMinor: 500,
        grossMinor: 100_000,
        kind: "sell",
      }),
    );
  });
});

describe("isDeclaredOpening (#1567)", () => {
  test("an alta stamp is an apertura; a real buy is not", () => {
    expect(isDeclaredOpening(op("buy", { source: "opening" }))).toBe(true);
    expect(isDeclaredOpening(op("buy", { source: "manual" }))).toBe(false);
    expect(isDeclaredOpening(op("buy"))).toBe(false);
  });
});
