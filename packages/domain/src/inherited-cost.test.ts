import { describe, expect, test } from "vitest";
import {
  answerInheritedCost,
  confirmTransferOrigin,
  hasPendingInheritedCost,
  pendingInheritedCostEntries,
  proposeTransferOrigin,
} from "./inherited-cost";
import type { InvestmentOperation } from "./investment-types";
import { derivePosition } from "./positions";
import { auditTransferPairs } from "./transfer-pair-integrity";

const ORIGIN = "fondo-origen";
const DESTINATION = "fondo-destino";

/** 37 participaciones a 23,17 € — 857,29 € de coste. */
const originBuy: InvestmentOperation = {
  assetId: ORIGIN,
  currency: "EUR",
  executedAt: "2025-03-04",
  feesMinor: 0,
  id: "op-buy",
  kind: "buy",
  pricePerUnit: "23.17",
  source: "connected",
  units: "37",
};

/** The reimbursement nobody paired: written as a sale, marked as an unpaired out. */
function reimbursement(
  overrides: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId: ORIGIN,
    currency: "EUR",
    executedAt: "2026-06-11",
    feesMinor: 0,
    id: "op-out",
    kind: "sell",
    pricePerUnit: "26.41",
    source: "connected",
    transferLegState: "unpaired_out",
    units: "37",
    ...overrides,
  };
}

/** The entry whose cost is pending: provisional cost = what arrived (971,03 €). */
function entry(overrides: Partial<InvestmentOperation> = {}): InvestmentOperation {
  return {
    assetId: DESTINATION,
    currency: "EUR",
    executedAt: "2026-06-16",
    feesMinor: 0,
    id: "op-in",
    kind: "transfer_in",
    pricePerUnit: "23.5116",
    source: "connected",
    transferCostMinor: 97_103,
    transferId: "myinvestor-unpaired:in-ref",
    transferLegState: "cost_pending",
    units: "41.3",
    ...overrides,
  };
}

describe("pending inherited cost", () => {
  test("only a transfer_in still marked cost_pending is pending", () => {
    const answered = entry({ id: "op-done", transferLegState: "cost_declared" });
    const ledger = [answered, entry()];

    expect(pendingInheritedCostEntries(ledger).map((op) => op.id)).toEqual(["op-in"]);
    expect(hasPendingInheritedCost(ledger)).toBe(true);
    expect(hasPendingInheritedCost([answered, originBuy])).toBe(false);
  });
});

describe("proposeTransferOrigin", () => {
  test("proposes the unpaired reimbursement of the 10 days before, within ±5 %", () => {
    expect(proposeTransferOrigin(entry(), [reimbursement()])?.id).toBe("op-out");
  });

  test("the window is ten days back, the entry's own day included", () => {
    expect(
      proposeTransferOrigin(entry(), [reimbursement({ executedAt: "2026-06-06" })])?.id,
    ).toBe("op-out");
    expect(
      proposeTransferOrigin(entry(), [reimbursement({ executedAt: "2026-06-16" })])?.id,
    ).toBe("op-out");
    expect(
      proposeTransferOrigin(entry(), [reimbursement({ executedAt: "2026-06-05" })]),
    ).toBeNull();
    // A reimbursement AFTER the entry cannot have funded it.
    expect(
      proposeTransferOrigin(entry(), [reimbursement({ executedAt: "2026-06-17" })]),
    ).toBeNull();
  });

  test("an amount more than 5 % away is no proposal", () => {
    // 971,03 × 1,05 = 1.019,58: 38,61 × 26,41 = 1.019,69 is just past it.
    expect(
      proposeTransferOrigin(entry(), [reimbursement({ units: "38.61" })]),
    ).toBeNull();
    expect(proposeTransferOrigin(entry(), [reimbursement({ units: "38.6" })])?.id).toBe(
      "op-out",
    );
  });

  test("a plain sale, a paired leg or the entry's own holding is never proposed", () => {
    const { transferLegState: _unpaired, ...plainSale } = reimbursement();
    expect(proposeTransferOrigin(entry(), [plainSale])).toBeNull();
    expect(
      proposeTransferOrigin(entry(), [reimbursement({ assetId: DESTINATION })]),
    ).toBeNull();
  });

  test("an entry whose cost is not pending asks for nothing", () => {
    expect(
      proposeTransferOrigin(entry({ transferLegState: "cost_declared" }), [
        reimbursement(),
      ]),
    ).toBeNull();
  });

  test("of several that fit, the nearest amount wins, then the nearest day", () => {
    const far = reimbursement({ id: "op-far", units: "37.9" });
    const near = reimbursement({ id: "op-near", units: "36.8" });
    expect(proposeTransferOrigin(entry(), [far, near])?.id).toBe("op-near");

    const early = reimbursement({ executedAt: "2026-06-08", id: "op-early" });
    const late = reimbursement({ executedAt: "2026-06-12", id: "op-late" });
    expect(proposeTransferOrigin(entry(), [early, late])?.id).toBe("op-late");
  });
});

describe("answerInheritedCost", () => {
  test("the typed cost replaces the provisional one and the mark says who put it", () => {
    const result = answerInheritedCost(entry(), 81_337);
    expect(result).toEqual({
      ok: true,
      value: { ...entry(), transferCostMinor: 81_337, transferLegState: "cost_declared" },
    });
  });

  test("refuses a cost that is not a positive amount", () => {
    expect(answerInheritedCost(entry(), 0)).toEqual({
      ok: false,
      reason: "cost_not_positive",
    });
    expect(answerInheritedCost(entry(), 12.5)).toEqual({
      ok: false,
      reason: "cost_not_positive",
    });
  });

  test("refuses a row whose cost is not pending", () => {
    expect(
      answerInheritedCost(entry({ transferLegState: "cost_declared" }), 81_337),
    ).toEqual({ ok: false, reason: "not_pending" });
    expect(answerInheritedCost(originBuy, 81_337)).toEqual({
      ok: false,
      reason: "not_pending",
    });
  });
});

describe("confirmTransferOrigin", () => {
  const originLedger = [originBuy, reimbursement()];

  test("the two legs become one traspaso: the sale stops realizing and the cost travels", () => {
    const result = confirmTransferOrigin({
      entry: entry(),
      origin: reimbursement(),
      originLedger,
    });
    if (!result.ok) throw new Error(result.reason);

    const { incoming, out } = result.value;
    expect(out).toMatchObject({
      id: "op-out",
      kind: "transfer_out",
      transferId: "myinvestor-unpaired:in-ref",
    });
    expect(out.transferLegState).toBeUndefined();
    // The whole origin left: its whole cost, 857,29 €, is what the entry inherits.
    expect(incoming).toMatchObject({
      id: "op-in",
      transferCostMinor: 85_729,
      transferId: "myinvestor-unpaired:in-ref",
      transferLegState: "cost_from_origin",
    });

    // Before, the reimbursement realized a gain; after, nothing is realized.
    const before = derivePosition(originLedger, { assetId: ORIGIN, currency: "EUR" });
    const after = derivePosition([originBuy, out], { assetId: ORIGIN, currency: "EUR" });
    expect(before.realizedPnl.amountMinor).toBe(97_717 - 85_729);
    expect(after.realizedPnl.amountMinor).toBe(0);

    // The pair passes the book's own audit: same fold, zero drift.
    expect(
      auditTransferPairs({
        operationsByAssetId: new Map([
          [ORIGIN, [originBuy, out]],
          [DESTINATION, [incoming]],
        ]),
      }),
    ).toEqual([]);
  });

  test("only part of the origin leaving takes its average-cost share", () => {
    const partial = reimbursement({ units: "12.4" });
    const ledger = [originBuy, partial, entry({ units: "13.9" })];
    const result = confirmTransferOrigin({
      entry: entry({ transferCostMinor: 32_517, units: "13.9" }),
      origin: partial,
      originLedger: ledger.filter((op) => op.assetId === ORIGIN),
    });
    if (!result.ok) throw new Error(result.reason);
    // 857,29 × 12,4 / 37 = 287,31.
    expect(result.value.incoming.transferCostMinor).toBe(28_731);
  });

  test("refuses an origin the rule would not propose", () => {
    expect(
      confirmTransferOrigin({
        entry: entry(),
        origin: reimbursement({ executedAt: "2026-05-02" }),
        originLedger,
      }),
    ).toEqual({ ok: false, reason: "not_a_candidate" });
  });

  test("refuses an origin that charged a fee: a transfer_out carries none", () => {
    const charged = reimbursement({ feesMinor: 113 });
    expect(
      confirmTransferOrigin({
        entry: entry(),
        origin: charged,
        originLedger: [originBuy, charged],
      }),
    ).toEqual({ ok: false, reason: "origin_has_fees" });
  });
});
