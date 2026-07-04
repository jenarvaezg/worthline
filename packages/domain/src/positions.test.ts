import { describe, expect, test } from "vitest";

import type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
  OperationKind,
} from "./index";
import { createInvestmentOperation, derivePosition } from "./positions";

function op(
  kind: OperationKind,
  units: string,
  pricePerUnit: string,
  extra: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId: "asset_inv",
    currency: "EUR",
    executedAt: "2026-01-01",
    feesMinor: 0,
    id: `op_${kind}_${units}_${pricePerUnit}`,
    kind,
    pricePerUnit,
    units,
    ...extra,
  };
}

const buy = (units: string, price: string, extra: Partial<InvestmentOperation> = {}) =>
  op("buy", units, price, extra);
const sell = (units: string, price: string, extra: Partial<InvestmentOperation> = {}) =>
  op("sell", units, price, extra);

describe("derivePosition — buys", () => {
  test("accumulates units and cost basis from buys", () => {
    const position = derivePosition(
      [
        buy("10", "100", { executedAt: "2026-01-01", id: "op1" }),
        buy("5", "120", { executedAt: "2026-02-01", id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("15");
    expect(position.costBasis).toEqual({ amountMinor: 160_000, currency: "EUR" });
    expect(position.averageUnitCost).toBe("106.6667"); // 1600.00 / 15
    expect(position.warnings).toEqual([]);
  });

  test("an empty ledger is a flat, zero-cost position", () => {
    const position = derivePosition([], { assetId: "asset_inv", currency: "EUR" });

    expect(position.currentUnits).toBe("0");
    expect(position.costBasis).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(position.averageUnitCost).toBe("0");
  });
});

describe("derivePosition — sells (moving weighted average)", () => {
  test("a sell removes units and a proportional slice of cost basis at the running average", () => {
    const position = derivePosition(
      [
        buy("10", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("4", "150", { executedAt: "2026-02-01", id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("6");
    expect(position.costBasis).toEqual({ amountMinor: 60_000, currency: "EUR" });
    expect(position.averageUnitCost).toBe("100"); // a sale does not move the average
  });

  test("selling the whole position zeroes units and cost basis", () => {
    const position = derivePosition(
      [
        buy("10", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("10", "130", { executedAt: "2026-02-01", id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("0");
    expect(position.costBasis).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(position.averageUnitCost).toBe("0");
  });
});

describe("derivePosition — fees", () => {
  test("buy fees increase cost basis and the weighted average", () => {
    const position = derivePosition(
      [buy("10", "100", { feesMinor: 1_000, id: "op1" })], // 1000.00 + 10.00 fee
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.costBasis).toEqual({ amountMinor: 101_000, currency: "EUR" });
    expect(position.averageUnitCost).toBe("101"); // 1010.00 / 10
  });

  test("sell fees do not change the remaining cost basis", () => {
    const position = derivePosition(
      [
        buy("10", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("5", "120", { executedAt: "2026-02-01", feesMinor: 500, id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.costBasis).toEqual({ amountMinor: 50_000, currency: "EUR" });
  });
});

describe("derivePosition — market value and unrealized P/L", () => {
  test("derives market value and unrealized P/L when a current price is known", () => {
    const position = derivePosition([buy("10", "100", { id: "op1" })], {
      assetId: "asset_inv",
      currency: "EUR",
      currentPricePerUnit: "130",
    });

    expect(position.marketValue).toEqual({ amountMinor: 130_000, currency: "EUR" });
    expect(position.unrealizedPnl).toEqual({ amountMinor: 30_000, currency: "EUR" });
  });

  test("omits market value and P/L when no current price is available", () => {
    const position = derivePosition([buy("10", "100", { id: "op1" })], {
      assetId: "asset_inv",
      currency: "EUR",
    });

    expect(position.marketValue).toBeUndefined();
    expect(position.unrealizedPnl).toBeUndefined();
  });
});

describe("derivePosition — oversell", () => {
  test("selling more units than held is an overrideable warning, clamped to available", () => {
    const position = derivePosition(
      [
        buy("5", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("8", "120", { executedAt: "2026-02-01", id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("0");
    expect(position.costBasis).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(position.warnings).toHaveLength(1);
    expect(position.warnings[0]).toContain("unidades");
  });

  test("a position never goes negative even after an oversell", () => {
    const position = derivePosition(
      [
        buy("5", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("8", "120", { executedAt: "2026-02-01", id: "op2" }),
        buy("2", "110", { executedAt: "2026-03-01", id: "op3" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("2"); // oversell clamped to 0, then +2 bought
    expect(position.costBasis).toEqual({ amountMinor: 22_000, currency: "EUR" });
  });
});

describe("derivePosition — realized P/L (#548)", () => {
  test("a buy-only position has zero realized P/L", () => {
    const position = derivePosition([buy("10", "100", { id: "op1" })], {
      assetId: "asset_inv",
      currency: "EUR",
    });

    expect(position.realizedPnl).toEqual({ amountMinor: 0, currency: "EUR" });
  });

  test("a partial sell realizes proceeds minus the cost of the units sold", () => {
    const position = derivePosition(
      [
        buy("10", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("4", "150", { executedAt: "2026-02-01", id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    // sold 4 units bought at 100.00, sold at 150.00 → 4 × 50.00 = 200.00 realized
    expect(position.realizedPnl).toEqual({ amountMinor: 20_000, currency: "EUR" });
    // remaining 6 units keep their proportional cost basis
    expect(position.costBasis).toEqual({ amountMinor: 60_000, currency: "EUR" });
  });

  test("a fully-sold position has the full realized gain and zero unrealized", () => {
    const position = derivePosition(
      [
        buy("10", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("10", "130", { executedAt: "2026-02-01", id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR", currentPricePerUnit: "140" },
    );

    expect(position.realizedPnl).toEqual({ amountMinor: 30_000, currency: "EUR" });
    // no units remain → market value 0, unrealized 0 (against a 0 cost basis)
    expect(position.marketValue).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(position.unrealizedPnl).toEqual({ amountMinor: 0, currency: "EUR" });
  });

  test("sell fees reduce the realized gain", () => {
    const position = derivePosition(
      [
        buy("10", "100", { executedAt: "2026-01-01", id: "op1" }),
        sell("5", "120", { executedAt: "2026-02-01", feesMinor: 500, id: "op2" }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    // proceeds 600.00 − 5.00 fees = 595.00; cost of 5 units = 500.00 → 95.00 realized
    expect(position.realizedPnl).toEqual({ amountMinor: 9_500, currency: "EUR" });
  });
});

describe("createInvestmentOperation", () => {
  const base: CreateInvestmentOperationInput = {
    assetId: "asset_inv",
    currency: "EUR",
    executedAt: "2026-01-01",
    id: "op1",
    kind: "buy",
    pricePerUnit: "100",
    units: "1.5",
  };

  test("normalizes a valid operation with default zero fees", () => {
    const operation = createInvestmentOperation(base);

    expect(operation.feesMinor).toBe(0);
    expect(operation.units).toBe("1.5");
    expect(operation.kind).toBe("buy");
  });

  test("rejects non-positive units", () => {
    expect(() => createInvestmentOperation({ ...base, units: "0" })).toThrow("units");
    expect(() => createInvestmentOperation({ ...base, units: "-1" })).toThrow("units");
  });

  test("rejects negative fees", () => {
    expect(() => createInvestmentOperation({ ...base, feesMinor: -1 })).toThrow("fees");
  });
});
