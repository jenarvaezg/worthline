import type {
  InvestmentOperation,
  ManagedPortfolio,
  MoneyMinor,
  MonthlyCloseValue,
  OperationKind,
} from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { portfolioReturnView } from "./carteras-returns-view";

const eur = (amountMinor: number): MoneyMinor => ({ amountMinor, currency: "EUR" });

function op(
  assetId: string,
  kind: OperationKind,
  units: string,
  pricePerUnit: string,
  executedAt: string,
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${assetId}_${kind}_${executedAt}`,
    kind,
    pricePerUnit,
    units,
  };
}

const portfolio = (holdingIds: string[]): ManagedPortfolio => ({
  holdingIds,
  id: "p1",
  name: "Cartera Indexada Metal",
  provider: "MyInvestor",
  scopeId: "s1",
  witness: null,
});

function view(input: {
  holdingIds: string[];
  moneyByHoldingId: Array<[string, MoneyMinor]>;
  typeByHoldingId: Array<[string, string]>;
  operations?: Array<[string, InvestmentOperation[]]>;
  monthlyCloses?: Array<[string, MonthlyCloseValue[]]>;
}) {
  return portfolioReturnView({
    baseCurrency: "EUR",
    monthlyClosesByHoldingId: new Map(input.monthlyCloses ?? []),
    moneyByHoldingId: new Map(input.moneyByHoldingId),
    operationsByHoldingId: new Map(input.operations ?? []),
    portfolio: portfolio(input.holdingIds),
    today: "2026-08-21",
    typeByHoldingId: new Map(input.typeByHoldingId),
  });
}

describe("portfolioReturnView", () => {
  it("mide los fondos y deja el efectivo fuera del retorno", () => {
    // El caso real: 1.345,12 € invertidos que hoy valen 1.497,37 € → +11,32 %.
    // El efectivo (7,34 €) suma al valor de la cartera, nunca al retorno.
    const result = view({
      holdingIds: ["fondo", "efectivo"],
      moneyByHoldingId: [
        ["fondo", eur(149_737)],
        ["efectivo", eur(734)],
      ],
      operations: [["fondo", [op("fondo", "buy", "1000", "1.34512", "2024-01-15")]]],
      typeByHoldingId: [
        ["fondo", "investment"],
        ["efectivo", "cash"],
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.investedMinor).toBe(134_512);
    expect(result?.gainMinor).toBe(15_225);
    expect(result?.view.totalReturnRatio).toBeCloseTo(0.1132, 4);
    expect(result?.coveredMinor).toBe(149_737);
    expect(result?.cashMinor).toBe(734);
    expect(result?.uncoveredMinor).toBe(0);
    expect(result?.message).toContain("efectivo");
  });

  it("un traspaso entre dos fondos de la cartera no infla lo invertido", () => {
    const result = view({
      holdingIds: ["a", "b"],
      moneyByHoldingId: [
        ["a", eur(0)],
        ["b", eur(120_000)],
      ],
      operations: [
        [
          "a",
          [
            op("a", "buy", "10", "100", "2024-01-01"),
            op("a", "transfer_out", "10", "110", "2025-01-01"),
          ],
        ],
        ["b", [op("b", "transfer_in", "10", "110", "2025-01-01")]],
      ],
      typeByHoldingId: [
        ["a", "investment"],
        ["b", "investment"],
      ],
    });

    expect(result?.investedMinor).toBe(100_000);
    expect(result?.gainMinor).toBe(20_000);
  });

  it("el agregado sin detallar queda fuera de la medida y se declara", () => {
    const result = view({
      holdingIds: ["fondo", "agregado", "efectivo"],
      moneyByHoldingId: [
        ["fondo", eur(50_000)],
        ["agregado", eur(60_000)],
        ["efectivo", eur(1_000)],
      ],
      operations: [["fondo", [op("fondo", "buy", "10", "40", "2024-01-01")]]],
      typeByHoldingId: [
        ["fondo", "investment"],
        ["agregado", "manual"],
        ["efectivo", "cash"],
      ],
    });

    expect(result?.coveredMinor).toBe(50_000);
    expect(result?.uncoveredMinor).toBe(60_000);
    expect(result?.investedMinor).toBe(40_000);
    expect(result?.message).toContain("sin detallar");
  });

  it("con reembolsos por medio, dice por qué su cifra y la del gestor difieren", () => {
    // El rebalanceo real de la Metal: vendió en enero y recompró en febrero. La
    // ganancia de worthline lleva dentro lo realizado; la del gestor, no.
    const result = view({
      holdingIds: ["fondo"],
      moneyByHoldingId: [["fondo", eur(60_000)]],
      operations: [
        [
          "fondo",
          [
            op("fondo", "buy", "100", "10", "2025-01-10"),
            op("fondo", "sell", "40", "9", "2026-01-30"),
            op("fondo", "buy", "40", "10", "2026-02-11"),
          ],
        ],
      ],
      typeByHoldingId: [["fondo", "investment"]],
    });

    expect(result?.proceedsMinor).toBe(36_000);
    // 100.000 + 40.000 aportados, 36.000 devueltos, 60.000 hoy: −44.000.
    expect(result?.investedMinor).toBe(140_000);
    expect(result?.gainMinor).toBe(-44_000);
    expect(result?.message).toContain("reembolsos");
  });

  it("sin ningún fondo con operaciones no hay retorno que enseñar", () => {
    expect(
      view({
        holdingIds: ["agregado", "efectivo"],
        moneyByHoldingId: [
          ["agregado", eur(60_000)],
          ["efectivo", eur(1_000)],
        ],
        typeByHoldingId: [
          ["agregado", "manual"],
          ["efectivo", "cash"],
        ],
      }),
    ).toBeNull();
  });

  it("un fondo en otra divisa no entra en la medida: se cuenta y se dice", () => {
    const result = view({
      holdingIds: ["euro", "dolar"],
      moneyByHoldingId: [
        ["euro", eur(100_000)],
        ["dolar", { amountMinor: 50_000, currency: "USD" }],
      ],
      operations: [
        ["euro", [op("euro", "buy", "10", "80", "2024-01-01")]],
        ["dolar", [op("dolar", "buy", "10", "40", "2024-01-01")]],
      ],
      typeByHoldingId: [
        ["euro", "investment"],
        ["dolar", "investment"],
      ],
    });

    expect(result?.investedMinor).toBe(80_000);
    expect(result?.excludedForeignCount).toBe(1);
    expect(result?.message).toContain("divisa");
  });

  it("la TWR sale de los cierres mensuales de los miembros", () => {
    const closes = (start: number, end: number): MonthlyCloseValue[] => [
      { date: "2026-01-31", valueMinor: start },
      { date: "2026-07-31", valueMinor: end },
    ];
    const result = view({
      holdingIds: ["a", "b"],
      monthlyCloses: [
        ["a", closes(50_000, 55_000)],
        ["b", closes(50_000, 55_000)],
      ],
      moneyByHoldingId: [
        ["a", eur(55_000)],
        ["b", eur(55_000)],
      ],
      operations: [
        ["a", [op("a", "buy", "10", "50", "2025-01-01")]],
        ["b", [op("b", "buy", "10", "50", "2025-01-01")]],
      ],
      typeByHoldingId: [
        ["a", "investment"],
        ["b", "investment"],
      ],
    });

    expect(result?.view.twr?.rate).toBeCloseTo(0.1, 10);
  });
});
