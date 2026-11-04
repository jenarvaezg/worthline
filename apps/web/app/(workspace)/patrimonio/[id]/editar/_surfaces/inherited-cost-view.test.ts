import type { InvestmentOperation } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { inheritedCostView, withUnknownOrigins } from "./inherited-cost-view";

const originBuy: InvestmentOperation = {
  assetId: "origen",
  currency: "EUR",
  executedAt: "2025-03-04",
  feesMinor: 0,
  id: "op-buy",
  kind: "buy",
  pricePerUnit: "23.17",
  source: "connected",
  units: "37",
};

const reimbursement: InvestmentOperation = {
  assetId: "origen",
  currency: "EUR",
  executedAt: "2026-06-11",
  feesMinor: 0,
  id: "op-out",
  kind: "sell",
  pricePerUnit: "26.41",
  source: "connected",
  transferLegState: "unpaired_out",
  units: "37",
};

function entry(transferId: string): InvestmentOperation {
  return {
    assetId: "destino",
    currency: "EUR",
    executedAt: "2026-06-16",
    feesMinor: 0,
    id: "op-in",
    kind: "transfer_in",
    pricePerUnit: "23.5116",
    source: "connected",
    transferCostMinor: 97_103,
    transferId,
    transferLegState: "cost_pending",
    units: "41.3",
  };
}

const names = new Map([["origen", "Fondo Origen"]]);

describe("inheritedCostView", () => {
  test("nothing pending, nothing to ask", () => {
    expect(
      inheritedCostView({
        candidates: [],
        holdingNames: names,
        operations: [originBuy],
        originLedger: null,
      }),
    ).toBeNull();
  });

  test("an external entry asks for the cost, with where to find it and no proposal", () => {
    const view = inheritedCostView({
      candidates: [reimbursement],
      holdingNames: names,
      operations: [entry("myinvestor-external:r1")],
      originLedger: null,
    });

    expect(view).toMatchObject({
      arrivedMinor: 97_103,
      date: "16/06/2026",
      entryId: "op-in",
      origin: "external",
      pendingCount: 1,
      proposal: null,
      units: "41,3",
    });
  });

  test("an internal entry with a reimbursement in reach proposes it, with the cost that would travel", () => {
    const view = inheritedCostView({
      candidates: [reimbursement],
      holdingNames: names,
      operations: [entry("myinvestor-unpaired:r3")],
      originLedger: [originBuy, reimbursement],
    });

    expect(view?.origin).toBe("internal");
    expect(view?.proposal).toEqual({
      amountMinor: 97_717,
      costMinor: 85_729,
      date: "11/06/2026",
      holdingName: "Fondo Origen",
      originId: "op-out",
    });
  });

  test("an unpaired leg claims no origin in the ledger; an external entry keeps «otra entidad»", () => {
    const unpaired = entry("myinvestor-unpaired:r3");
    const external = { ...entry("myinvestor-external:r1"), id: "op-ext" };
    expect(
      withUnknownOrigins([unpaired, external], {
        "op-ext": { kind: "external" },
        "op-in": { kind: "external" },
      }),
    ).toEqual({ "op-ext": { kind: "external" }, "op-in": { kind: "unresolved" } });
  });

  test("an internal entry with nothing in reach asks for the cost", () => {
    const view = inheritedCostView({
      candidates: [{ ...reimbursement, executedAt: "2026-04-02" }],
      holdingNames: names,
      operations: [entry("myinvestor-unpaired:r3")],
      originLedger: null,
    });

    expect(view).toMatchObject({ origin: "internal", proposal: null });
  });
});
