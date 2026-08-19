import { describe, expect, test } from "vitest";
import { asInstant } from "./dates";
import type {
  CreateInvestmentOperationInput,
  InvestmentOperation,
  OperationKind,
} from "./index";
import {
  createInvestmentOperation,
  derivePosition,
  netUnitsByAsset,
  netUnitsFromOperations,
} from "./positions";

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
  test("orders same-day operations by occurredAt before id", () => {
    const position = derivePosition(
      [
        sell("5", "120", {
          executedAt: "2026-01-01",
          id: "a_sell",
          occurredAt: asInstant("2026-01-01T10:00:00.000Z"),
        }),
        buy("5", "100", {
          executedAt: "2026-01-01",
          id: "z_buy",
          occurredAt: asInstant("2026-01-01T09:00:00.000Z"),
        }),
      ],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("0");
    expect(position.warnings).toEqual([]);
  });

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

  test("accepts and preserves a UTC occurredAt instant", () => {
    const occurredAt = "2026-01-01T09:30:00.000Z";

    expect(createInvestmentOperation({ ...base, occurredAt }).occurredAt).toBe(
      occurredAt,
    );
  });

  test("rejects a non-UTC occurredAt timestamp", () => {
    expect(() =>
      createInvestmentOperation({
        ...base,
        occurredAt: "2026-01-01T10:30:00.000+01:00",
      }),
    ).toThrow("occurredAt");
  });

  test("rejects non-positive units", () => {
    expect(() => createInvestmentOperation({ ...base, units: "0" })).toThrow("units");
    expect(() => createInvestmentOperation({ ...base, units: "-1" })).toThrow("units");
  });

  test("rejects negative fees", () => {
    expect(() => createInvestmentOperation({ ...base, feesMinor: -1 })).toThrow("fees");
  });
});

describe("netUnitsFromOperations / netUnitsByAsset (#1348)", () => {
  test("folds a ledger to what is still held", () => {
    expect(netUnitsFromOperations([buy("10", "100"), sell("4", "120")])).toBe("6");
  });

  test("a fully-sold position nets to exactly zero", () => {
    expect(netUnitsFromOperations([buy("10", "100"), sell("10", "120")])).toBe("0");
  });

  test("an over-sell clamps like derivePosition rather than going negative", () => {
    expect(netUnitsFromOperations([buy("10", "100"), sell("12", "120")])).toBe("0");
  });

  test("an empty ledger holds nothing", () => {
    expect(netUnitsFromOperations([])).toBe("0");
  });

  test("keys the map by holding and leaves operation-less holdings out", () => {
    const netUnits = netUnitsByAsset(
      new Map([
        ["open", [buy("3", "50")]],
        ["closed", [buy("3", "50"), sell("3", "60")]],
        ["unstarted", []],
      ]),
    );

    expect([...netUnits]).toEqual([
      ["open", "3"],
      ["closed", "0"],
    ]);
  });
});

describe("derivePosition — the mixed-currency guard (#1401)", () => {
  test("warns when the ledger is not in the currency the cost is labelled with", () => {
    // The father's eight USD purchases, folded and labelled EUR: a cost basis 17,7 %
    // too high, and until now completely silent.
    const position = derivePosition([buy("0.255", "8.00", { currency: "USD" })], {
      assetId: "asset_inv",
      currency: "EUR",
    });

    expect(position.currencyWarning).toContain("USD");
    expect(position.currencyWarning).toContain("EUR");
    // NOT in `warnings`: its only consumer reads any entry there as an over-sell and
    // would report a currency problem as «venta excede posición».
    expect(position.warnings).toEqual([]);
  });

  test("a single-currency ledger says nothing", () => {
    const position = derivePosition([buy("10", "100"), sell("4", "120")], {
      assetId: "asset_inv",
      currency: "EUR",
    });

    expect(position.currencyWarning).toBeUndefined();
    expect(position.warnings).toEqual([]);
  });

  test("an over-sell in a mixed-currency ledger reports BOTH, each in its channel", () => {
    const position = derivePosition(
      [buy("10", "100", { currency: "USD" }), sell("12", "120", { currency: "USD" })],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.warnings).toHaveLength(1);
    expect(position.warnings[0]).toContain("unidades");
    expect(position.currencyWarning).toContain("USD");
  });
});

describe("createInvestmentOperation — the captured apunte (#1401)", () => {
  const input: CreateInvestmentOperationInput = {
    assetId: "asset_inv",
    capture: {
      currency: "USD",
      eurPerUnit: 0.85,
      feesMinor: 0,
      pricePerUnit: "8.00",
    },
    currency: "EUR",
    executedAt: "2026-01-23",
    id: "op_usd",
    kind: "buy",
    pricePerUnit: "6.8",
    units: "0.255",
  };

  test("carries the capture onto the operation", () => {
    expect(createInvestmentOperation(input).capture).toEqual(input.capture);
  });

  test("leaves the field absent — not null — for a euro apunte", () => {
    const { capture: _capture, ...euroInput } = input;
    expect("capture" in createInvestmentOperation(euroInput)).toBe(false);
  });
});

describe("derivePosition — el traspaso (#1393)", () => {
  const transferOut = (
    units: string,
    price: string,
    extra: Partial<InvestmentOperation> = {},
  ) => op("transfer_out", units, price, { transferId: "trf_1", ...extra });
  const transferIn = (
    units: string,
    price: string,
    costMinor: number,
    extra: Partial<InvestmentOperation> = {},
  ) =>
    op("transfer_in", units, price, {
      transferCostMinor: costMinor,
      transferId: "trf_1",
      ...extra,
    });

  test("el origen suelta unidades y coste proporcional sin realizar P/L", () => {
    // 10 units at 100 € = 1.000 €; half leaves at 150 € — a sell here would realize
    // 250 €, a traspaso realizes nothing.
    const position = derivePosition(
      [buy("10", "100"), transferOut("5", "150", { executedAt: "2026-02-01" })],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("5");
    expect(position.costBasis).toEqual({ amountMinor: 50_000, currency: "EUR" });
    expect(position.realizedPnl).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(position.warnings).toEqual([]);
  });

  test("el destino hereda el coste declarado, no unidades × precio", () => {
    const position = derivePosition([transferIn("5", "150", 50_000)], {
      assetId: "asset_dest",
      currency: "EUR",
      currentPricePerUnit: "150",
    });

    expect(position.currentUnits).toBe("5");
    // 750 € of market value standing on 500 € of inherited cost: the 250 € of
    // latent gain travelled intact instead of being reset by the transfer price.
    expect(position.costBasis).toEqual({ amountMinor: 50_000, currency: "EUR" });
    expect(position.unrealizedPnl).toEqual({ amountMinor: 25_000, currency: "EUR" });
    expect(position.realizedPnl).toEqual({ amountMinor: 0, currency: "EUR" });
  });

  test("el par cuadra: lo que sale del origen entra en el destino", () => {
    const origin = derivePosition(
      [buy("10", "100"), transferOut("5", "150", { executedAt: "2026-02-01" })],
      { assetId: "asset_inv", currency: "EUR" },
    );
    const destination = derivePosition(
      [
        transferIn("5", "150", origin.costBasis.amountMinor, {
          executedAt: "2026-02-01",
        }),
      ],
      { assetId: "asset_dest", currency: "EUR" },
    );

    expect(destination.currentUnits).toBe("5");
    expect(destination.costBasis.amountMinor + origin.costBasis.amountMinor).toBe(
      100_000,
    );
  });

  test("una comisión del traspaso se capitaliza en el destino", () => {
    const position = derivePosition(
      [transferIn("5", "150", 50_000, { feesMinor: 1_000 })],
      { assetId: "asset_dest", currency: "EUR" },
    );

    expect(position.costBasis).toEqual({ amountMinor: 51_000, currency: "EUR" });
  });

  test("un traspaso que excede lo disponible se ajusta con aviso, como la venta", () => {
    const position = derivePosition(
      [buy("2", "100"), transferOut("5", "150", { executedAt: "2026-02-01" })],
      { assetId: "asset_inv", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("0");
    expect(position.costBasis).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(position.realizedPnl).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(position.warnings).toHaveLength(1);
    expect(position.warnings[0]).toContain("traspaso");
  });

  test("un traspaso de entrada sin coste heredado no revienta el fold", () => {
    // A row written before #1393 — or by hand — has no inherited cost. The fold
    // reads it as zero rather than throwing: the ledger must still be readable.
    const position = derivePosition(
      [op("transfer_in", "5", "150", { transferId: "trf_1" })],
      { assetId: "asset_dest", currency: "EUR" },
    );

    expect(position.currentUnits).toBe("5");
    expect(position.costBasis).toEqual({ amountMinor: 0, currency: "EUR" });
  });
});

describe("createInvestmentOperation — las reglas de la fila de traspaso (#1393)", () => {
  const input = (
    overrides: Partial<CreateInvestmentOperationInput>,
  ): CreateInvestmentOperationInput => ({
    assetId: "asset_inv",
    currency: "EUR",
    executedAt: "2026-02-01",
    id: "op_trf",
    kind: "transfer_out",
    pricePerUnit: "150",
    units: "5",
    ...overrides,
  });

  test("un traspaso sin `transferId` no puede existir: nadie podría emparejarlo", () => {
    expect(() => createInvestmentOperation(input({}))).toThrow(/transferId/);
  });

  test("un `transfer_in` sin coste heredado no puede existir", () => {
    expect(() =>
      createInvestmentOperation(input({ kind: "transfer_in", transferId: "trf_1" })),
    ).toThrow(/transferCostMinor/);
  });

  test("el coste heredado no cabe en una compra ni en una venta", () => {
    expect(() =>
      createInvestmentOperation(input({ kind: "buy", transferCostMinor: 50_000 })),
    ).toThrow(/transferCostMinor/);
  });

  test("el coste heredado no puede ser negativo", () => {
    expect(() =>
      createInvestmentOperation(
        input({ kind: "transfer_in", transferCostMinor: -1, transferId: "trf_1" }),
      ),
    ).toThrow(/transferCostMinor/);
  });

  test("la mitad de salida no admite comisiones: el cargo va en la de entrada", () => {
    expect(() =>
      createInvestmentOperation(input({ feesMinor: 500, transferId: "trf_1" })),
    ).toThrow(/fees/i);
  });

  test("el par válido se construye y conserva sus dos columnas", () => {
    const operation = createInvestmentOperation(
      input({ kind: "transfer_in", transferCostMinor: 50_000, transferId: "trf_1" }),
    );

    expect(operation.transferId).toBe("trf_1");
    expect(operation.transferCostMinor).toBe(50_000);
  });
});
