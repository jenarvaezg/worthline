import { describe, expect, test } from "vitest";
import type { InvestmentOperation } from "./investment-types";
import {
  auditTransferPairs,
  describeBrokenTransferPairs,
} from "./transfer-pair-integrity";

function buy(
  assetId: string,
  id: string,
  executedAt: string,
  units: string,
  pricePerUnit: string,
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit,
    units,
  };
}

function transferOut(
  assetId: string,
  id: string,
  executedAt: string,
  units: string,
  pricePerUnit: string,
  transferId: string,
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "transfer_out",
    pricePerUnit,
    transferId,
    units,
  };
}

function transferIn(
  assetId: string,
  id: string,
  executedAt: string,
  units: string,
  pricePerUnit: string,
  transferId: string,
  transferCostMinor: number,
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "transfer_in",
    pricePerUnit,
    transferCostMinor,
    transferId,
    units,
  };
}

function ledger(...operations: InvestmentOperation[]) {
  const byAsset = new Map<string, InvestmentOperation[]>();
  for (const operation of operations) {
    const rows = byAsset.get(operation.assetId) ?? [];
    rows.push(operation);
    byAsset.set(operation.assetId, rows);
  }
  return byAsset;
}

/**
 * A healthy pair: 1.000 € of cost on 100 participaciones, half of them traspasadas,
 * so 500,00 € of acquisition cost travel with them.
 */
function healthyLedger() {
  return ledger(
    buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
    transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
    transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
  );
}

describe("auditTransferPairs — the healthy shape", () => {
  test("a pair with one leg each side and the cost the fold removes is silent", () => {
    expect(auditTransferPairs({ operationsByAssetId: healthyLedger() })).toEqual([]);
  });

  test("a transfer_in with no transferId is the legitimate entry from outside the book", () => {
    const operations = ledger({
      assetId: "inv_dest",
      currency: "EUR",
      executedAt: "2026-03-01",
      feesMinor: 0,
      id: "op_external",
      kind: "transfer_in",
      pricePerUnit: "24",
      transferCostMinor: 500_00,
      units: "25",
    });

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([]);
  });

  test("an empty ledger has nothing to pair", () => {
    expect(auditTransferPairs({ operationsByAssetId: new Map() })).toEqual([]);
  });
});

describe("auditTransferPairs — an orphan leg", () => {
  test("a transfer_out whose transfer_in is nowhere is reported with its cardinality", () => {
    const operations = ledger(
      buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([
      {
        fault: { inCount: 0, kind: "cardinality", outCount: 1, strayCount: 0 },
        holdingIds: ["inv_origin"],
        transferId: "trf_1",
      },
    ]);
  });

  test("a lone transfer_in WITH its own id is the external entry, not an orphan", () => {
    // #1541: a plan brought in from another institution carries a `transferId` of
    // its own so a reader finds one row and says «desde otra entidad». The audit
    // has to reach the same verdict the ficha reaches from the same evidence.
    const operations = ledger(
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([]);
  });

  test("the external entry stays exempt once it declares an inherited seniority", () => {
    // #1518 added a column to that row. The audit judges CARDINALITY, so a declared
    // seniority must not change its verdict — and the ficha, reading the same row,
    // prints «desde otra entidad · antigüedad desde …». Two screens, one reading
    // (#1422).
    const operations = ledger({
      ...transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
      transferSeniorityAt: "2014-03-01",
    });

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([]);
  });

  test("two incoming halves under one id have no external reading and are reported", () => {
    const operations = ledger(
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
      transferIn("inv_other", "op_in2", "2026-03-01", "25", "24", "trf_1", 500_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([
      {
        fault: { inCount: 2, kind: "cardinality", outCount: 0, strayCount: 0 },
        holdingIds: ["inv_dest", "inv_other"],
        transferId: "trf_1",
      },
    ]);
  });

  test("a buy carrying a transferId is counted, never quietly ignored", () => {
    const operations = ledger(
      { ...buy("inv_origin", "op_buy", "2026-01-10", "100", "10"), transferId: "trf_1" },
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })[0]?.fault).toEqual({
      inCount: 1,
      kind: "cardinality",
      outCount: 0,
      strayCount: 1,
    });
  });

  test("a transferId carrying three legs is reported, and no cost is careado", () => {
    const operations = ledger(
      buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
      transferIn("inv_other", "op_in2", "2026-03-01", "25", "24", "trf_1", 500_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([
      {
        fault: { inCount: 2, kind: "cardinality", outCount: 1, strayCount: 0 },
        holdingIds: ["inv_dest", "inv_origin", "inv_other"],
        transferId: "trf_1",
      },
    ]);
  });
});

describe("auditTransferPairs — the cost careo", () => {
  test("a declared cost one cent off the derived one is reported: tolerance is zero", () => {
    const operations = ledger(
      buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_01),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([
      {
        fault: {
          declaredCostMinor: 500_01,
          deltaMinor: 1,
          derivedCostMinor: 500_00,
          kind: "cost_drift",
        },
        holdingIds: ["inv_dest", "inv_origin"],
        transferId: "trf_1",
      },
    ]);
  });

  test("a transfer_in with no inherited cost at all is a drift of the whole slice", () => {
    const operations = ledger(
      buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
      {
        assetId: "inv_dest",
        currency: "EUR",
        executedAt: "2026-03-01",
        feesMinor: 0,
        id: "op_in",
        kind: "transfer_in",
        pricePerUnit: "24",
        transferId: "trf_1",
        units: "25",
      },
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })[0]?.fault).toEqual({
      declaredCostMinor: 0,
      deltaMinor: -500_00,
      derivedCostMinor: 500_00,
      kind: "cost_drift",
    });
  });

  test("the origin is folded up to the operation BEFORE the traspaso, never after it", () => {
    // A later buy at a different price would move the weighted average; reading the
    // whole ledger instead of the state on the day would fabricate a drift.
    const operations = ledger(
      buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
      buy("inv_origin", "op_buy_later", "2026-04-10", "100", "30"),
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([]);
  });

  test("same-day operations keep the fold's own order: an earlier id folds first", () => {
    // Both on 2026-03-01: `op_a_buy` sorts before `op_out` by id, so its 500 € of
    // cost are already in the position when the traspaso leaves.
    const operations = ledger(
      buy("inv_origin", "op_a_buy", "2026-03-01", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([]);
  });

  test("units past the position careo against what the fold actually removes", () => {
    // The gate refuses an over-transfer; a one-shot can still write one. The fold
    // clamps to the 100 held and removes the WHOLE 1.000 € of cost, so a row that
    // inherited the un-clamped proportion is a real corruption.
    const operations = ledger(
      buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "200", "12", "trf_1"),
      transferIn("inv_dest", "op_in", "2026-03-01", "100", "24", "trf_1", 2_000_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })[0]?.fault).toEqual({
      declaredCostMinor: 2_000_00,
      deltaMinor: 1_000_00,
      derivedCostMinor: 1_000_00,
      kind: "cost_drift",
    });
  });

  test("an outgoing row missing from its own key does not fold itself into the origin", () => {
    // A ledger keyed in a way this module did not expect. Folding everything under
    // the key — the traspaso included — would remove the cost twice and fabricate a
    // `high` drift out of nothing. The cut is by the fold's comparator, so the
    // operations before the traspaso are the same ones either way.
    const operations = new Map([
      ["inv_origin", [buy("inv_origin", "op_buy", "2026-01-10", "100", "10")]],
      [
        "otra_clave",
        [transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1")],
      ],
      [
        "inv_dest",
        [transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00)],
      ],
    ]);

    expect(auditTransferPairs({ operationsByAssetId: operations })).toEqual([]);
  });

  test("an origin with no ledger of its own careas against a cost of zero", () => {
    const operations = ledger(
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
      transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
    );

    expect(auditTransferPairs({ operationsByAssetId: operations })[0]?.fault).toEqual({
      declaredCostMinor: 500_00,
      deltaMinor: 500_00,
      derivedCostMinor: 0,
      kind: "cost_drift",
    });
  });
});

describe("auditTransferPairs — which pairs are asked", () => {
  test("only pairs with a leg on a holding of the set are audited", () => {
    const operations = ledger(
      buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
      transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
      transferOut("inv_other", "op_out2", "2026-03-01", "50", "12", "trf_2"),
    );

    const audited = auditTransferPairs({
      holdingIds: new Set(["inv_other"]),
      operationsByAssetId: operations,
    });

    expect(audited.map((pair) => pair.transferId)).toEqual(["trf_2"]);
  });

  test("the external entry stays silent even when the scope owns its holding", () => {
    expect(
      auditTransferPairs({
        holdingIds: new Set(["inv_dest"]),
        operationsByAssetId: ledger(
          transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 500_00),
        ),
      }),
    ).toEqual([]);
  });

  test("a pair is audited when EITHER leg belongs to the set", () => {
    const audited = auditTransferPairs({
      holdingIds: new Set(["inv_dest"]),
      operationsByAssetId: ledger(
        buy("inv_origin", "op_buy", "2026-01-10", "100", "10"),
        transferOut("inv_origin", "op_out", "2026-03-01", "50", "12", "trf_1"),
        transferIn("inv_dest", "op_in", "2026-03-01", "25", "24", "trf_1", 400_00),
      ),
    });

    expect(audited.map((pair) => pair.transferId)).toEqual(["trf_1"]);
  });

  test("broken pairs come out in a stable order, by transferId", () => {
    const operations = ledger(
      transferOut("inv_origin", "op_out_b", "2026-03-01", "50", "12", "trf_b"),
      transferOut("inv_origin_2", "op_out_a", "2026-03-01", "50", "12", "trf_a"),
    );

    expect(
      auditTransferPairs({ operationsByAssetId: operations }).map(
        (pair) => pair.transferId,
      ),
    ).toEqual(["trf_a", "trf_b"]);
  });
});

describe("describeBrokenTransferPairs", () => {
  test("one orphan names the transferId and the half that is missing", () => {
    const line = describeBrokenTransferPairs(
      [
        {
          fault: { inCount: 0, kind: "cardinality", outCount: 1, strayCount: 0 },
          holdingIds: ["inv_origin"],
          transferId: "trf_1",
        },
      ],
      "EUR",
    );

    expect(line).toContain("1 traspaso");
    expect(line).toContain("trf_1");
    expect(line).toContain("sin su mitad de entrada");
  });

  test("a cost drift quotes both figures to the cent", () => {
    const line = describeBrokenTransferPairs(
      [
        {
          fault: {
            declaredCostMinor: 500_01,
            deltaMinor: 1,
            derivedCostMinor: 500_00,
            kind: "cost_drift",
          },
          holdingIds: ["inv_dest", "inv_origin"],
          transferId: "trf_1",
        },
      ],
      "EUR",
    );

    expect(line).toContain("500,01");
    expect(line).toContain("500,00");
  });

  test("every transferId is named — the ids are what the line exists to carry", () => {
    const pairs = Array.from({ length: 8 }, (_, index) => ({
      fault: { inCount: 0, kind: "cardinality" as const, outCount: 1, strayCount: 0 },
      holdingIds: ["inv_origin"],
      transferId: `trf_${index}`,
    }));

    const line = describeBrokenTransferPairs(pairs, "EUR");

    expect(line).toContain("8 traspasos");
    for (const pair of pairs) {
      expect(line).toContain(pair.transferId);
    }
  });

  test("a stray row is named as such, never counted as a second outgoing leg", () => {
    const line = describeBrokenTransferPairs(
      [
        {
          fault: { inCount: 1, kind: "cardinality", outCount: 0, strayCount: 1 },
          holdingIds: ["inv_dest", "inv_origin"],
          transferId: "trf_1",
        },
      ],
      "EUR",
    );

    expect(line).toContain("0 salidas y 1 entrada");
    expect(line).toContain("1 operación que no es ninguna de las dos mitades");
  });
});
