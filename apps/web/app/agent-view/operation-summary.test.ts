import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { summarizeOperations } from "./operation-summary";

function operation(
  kind: InvestmentOperation["kind"],
  units: string,
  extra: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId: "asset",
    currency: "EUR",
    executedAt: "2026-08-19",
    feesMinor: 0,
    id: `op_${kind}_${units}`,
    kind,
    pricePerUnit: "100",
    units,
    ...extra,
  };
}

describe("summarizeOperations — el traspaso se cuenta aparte (#1393)", () => {
  test("las piernas del traspaso no engordan las compras ni las ventas", () => {
    const summary = summarizeOperations(
      [
        operation("buy", "10"),
        operation("transfer_in", "5", {
          transferCostMinor: 30_000,
          transferId: "trf_1",
        }),
        operation("transfer_out", "2", { transferId: "trf_2" }),
      ],
      "EUR",
    );

    expect(summary?.unitsBought).toBe("10");
    expect(summary?.unitsSold).toBe("0");
    expect(summary?.grossBuyAmount.amountMinor).toBe(100_000);
    expect(summary?.grossSellAmount.amountMinor).toBe(0);
    expect(summary?.transfers).toEqual({
      grossInAmount: { amountMinor: 50_000, currency: "EUR" },
      grossOutAmount: { amountMinor: 20_000, currency: "EUR" },
      unitsIn: "5",
      unitsOut: "2",
    });
  });

  test("un libro sin traspasos no arrastra el bloque", () => {
    const summary = summarizeOperations([operation("buy", "10")], "EUR");

    expect(summary?.transfers).toBeUndefined();
  });
});
