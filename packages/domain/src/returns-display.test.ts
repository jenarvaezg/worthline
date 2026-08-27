import { describe, expect, test } from "vitest";

import type { InvestmentOperation, OperationKind } from "./index";
import { money } from "./money";
import type { IrrResult, SimpleGain, TwrResult } from "./returns";
import {
  APPRECIATING_CAVEAT,
  buildHoldingReturnsView,
  buildPortfolioReturnsView,
  CLASS_ATTRIBUTION_CAVEAT,
  investmentReturnsById,
  MARKET_CAVEAT,
  MARKET_PAYOUTS_CAVEAT,
  portfolioReturnsView,
  returnsByAssetClassView,
  returnsKindForInstrument,
} from "./returns-display";
import { subsetReturns } from "./returns-subset";

function gain(overrides: Partial<SimpleGain> = {}): SimpleGain {
  return {
    annualized: true,
    cagr: 0.1,
    spanDays: 800,
    totalGain: money(5_039_00, "EUR"),
    totalInvestedMinor: 16_850_00,
    totalReturnRatio: 0.299,
    ...overrides,
  };
}

const okIrr: IrrResult = { rate: 0.082, reason: null };
const failedIrr: IrrResult = { rate: null, reason: "single_sign" };
const okTwr: TwrResult = {
  annualized: false,
  annualizedRate: null,
  endDate: "2024-03-31",
  rate: 0.071,
  reason: null,
  spanDays: 60,
  startDate: "2024-01-31",
};

function op(
  kind: OperationKind,
  units: string,
  pricePerUnit: string,
  executedAt: string,
  assetId = "asset_inv",
  extra: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${assetId}_${kind}_${executedAt}_${units}`,
    kind,
    pricePerUnit,
    units,
    ...extra,
  };
}

describe("returnsKindForInstrument", () => {
  test("market instruments (fund/etf/stock/index/pension_plan/crypto/precious_metal)", () => {
    for (const instrument of [
      "fund",
      "etf",
      "stock",
      "index",
      "pension_plan",
      "crypto",
      "precious_metal",
    ] as const) {
      expect(returnsKindForInstrument(instrument)).toBe("market");
    }
  });

  test("appreciating non-market instruments (property/vehicle/coin_collection)", () => {
    for (const instrument of ["property", "vehicle", "coin_collection"] as const) {
      expect(returnsKindForInstrument(instrument)).toBe("appreciating");
    }
  });

  test("cash, deposits and debts have no returns", () => {
    for (const instrument of [
      "current_account",
      "term_deposit",
      "mortgage",
      "loan",
      "credit_card",
      "other",
    ] as const) {
      expect(returnsKindForInstrument(instrument)).toBeNull();
    }
  });
});

describe("buildHoldingReturnsView", () => {
  test("market: simple gain + IRR + TWR + realized/unrealized split", () => {
    const view = buildHoldingReturnsView({
      instrument: "fund",
      simpleGain: gain(),
      irr: okIrr,
      twr: okTwr,
      realizedPnl: money(200_00, "EUR"),
      unrealizedPnl: money(4_839_00, "EUR"),
    });

    expect(view).not.toBeNull();
    expect(view!.kind).toBe("market");
    expect(view!.totalReturnRatio).toBe(0.299);
    expect(view!.irr).toEqual(okIrr);
    expect(view!.twr).toEqual(okTwr);
    expect(view!.realizedPnl).toEqual(money(200_00, "EUR"));
    expect(view!.unrealizedPnl).toEqual(money(4_839_00, "EUR"));
    expect(view!.caveats).toContain(MARKET_CAVEAT);
  });

  test("appreciating: simple gain only — IRR/TWR forced there are null, not bogus", () => {
    const view = buildHoldingReturnsView({
      instrument: "property",
      simpleGain: gain(),
      irr: okIrr,
    });

    expect(view!.kind).toBe("appreciating");
    expect(view!.irr).toBeNull();
    expect(view!.twr).toBeNull();
    expect(view!.realizedPnl).toBeNull();
    expect(view!.unrealizedPnl).toBeNull();
    expect(view!.caveats).toEqual([APPRECIATING_CAVEAT]);
  });

  test("no-returns instruments produce no view", () => {
    expect(
      buildHoldingReturnsView({
        instrument: "current_account",
        simpleGain: gain(),
        irr: okIrr,
      }),
    ).toBeNull();
  });

  test("sub-year span is total, never annualized", () => {
    const view = buildHoldingReturnsView({
      instrument: "etf",
      simpleGain: gain({ annualized: false, cagr: null, spanDays: 120 }),
      irr: okIrr,
    });

    expect(view!.annualized).toBe(false);
    expect(view!.cagr).toBeNull();
  });

  test("a failed IRR is carried through with its reason (renders as a dash upstream)", () => {
    const view = buildHoldingReturnsView({
      instrument: "stock",
      simpleGain: gain(),
      irr: failedIrr,
    });

    expect(view!.irr).toEqual(failedIrr);
    expect(view!.twr).toBeNull();
  });

  test("with payouts recorded, the honest-limits copy switches (#657)", () => {
    const view = buildHoldingReturnsView({
      instrument: "fund",
      simpleGain: gain(),
      irr: okIrr,
      payoutsIncluded: true,
    });

    expect(view!.caveats).toContain(MARKET_PAYOUTS_CAVEAT);
    expect(view!.caveats).not.toContain(MARKET_CAVEAT);
  });
});

describe("buildPortfolioReturnsView", () => {
  test("is a market view (three measures) regardless of instrument mix", () => {
    const view = buildPortfolioReturnsView(gain(), okIrr, okTwr);
    expect(view.kind).toBe("market");
    expect(view.irr).toEqual(okIrr);
    expect(view.twr).toEqual(okTwr);
    expect(view.caveats).toContain(MARKET_CAVEAT);
  });
});

describe("investmentReturnsById", () => {
  const currency = "EUR";
  const valuationDate = "2026-07-04";

  test("computes a view per operation-bearing holding, keyed by asset id", () => {
    const views = investmentReturnsById({
      operationsByAsset: new Map([["a1", [op("buy", "10", "100", "2024-01-01", "a1")]]]),
      instrumentByAsset: new Map([["a1", "fund"]]),
      cachedPriceByAsset: new Map([["a1", "150"]]),
      manualPriceByAsset: new Map(),
      monthlyClosesByAsset: new Map([
        [
          "a1",
          [
            { date: "2024-01-31", valueMinor: 100_000 },
            { date: "2026-07-04", valueMinor: 150_000 },
          ],
        ],
      ]),
      currency,
      valuationDate,
    });

    const view = views.get("a1");
    expect(view).toBeDefined();
    expect(view!.kind).toBe("market");
    // 10 units bought at 100 (cost 1000.00), now worth 10×150 = 1500.00 → +50%.
    expect(view!.totalReturnRatio).toBeCloseTo(0.5, 6);
    expect(view!.totalGain).toEqual(money(500_00, "EUR"));
    expect(view!.irr!.rate).not.toBeNull();
    expect(view!.twr!.rate).toBeCloseTo(0.5, 6);
    expect(view!.twr!.startDate).toBe("2024-01-31");
  });

  test("skips holdings without operations", () => {
    const views = investmentReturnsById({
      operationsByAsset: new Map([["a1", []]]),
      instrumentByAsset: new Map([["a1", "fund"]]),
      cachedPriceByAsset: new Map(),
      manualPriceByAsset: new Map(),
      currency,
      valuationDate,
    });
    expect(views.has("a1")).toBe(false);
  });

  test("an unpriced holding is valued at cost, never a fabricated −100% (#1314)", () => {
    const views = investmentReturnsById({
      // A just-created holding with a symbol whose first quote has not landed yet:
      // no cache row, no manual quote.
      operationsByAsset: new Map([["a1", [op("buy", "10", "100", "2026-07-01", "a1")]]]),
      instrumentByAsset: new Map([["a1", "etf"]]),
      cachedPriceByAsset: new Map(),
      manualPriceByAsset: new Map(),
      currency,
      valuationDate,
    });

    const view = views.get("a1")!;
    expect(view.totalGain).toEqual(money(0, "EUR"));
    expect(view.totalReturnRatio).toBe(0);
  });

  test("folds a holding's recorded payouts into its figures and caveat (#657)", () => {
    const views = investmentReturnsById({
      operationsByAsset: new Map([["a1", [op("buy", "10", "100", "2024-01-01", "a1")]]]),
      instrumentByAsset: new Map([["a1", "fund"]]),
      cachedPriceByAsset: new Map([["a1", "100"]]), // flat: value == cost
      manualPriceByAsset: new Map(),
      payoutsByAsset: new Map([["a1", [{ amountMinor: 50_000, date: "2025-01-01" }]]]),
      currency,
      valuationDate,
    });

    const view = views.get("a1")!;
    // +500.00 distribution lands as realized gain on a flat holding.
    expect(view.totalGain).toEqual(money(500_00, "EUR"));
    expect(view.caveats).toContain(MARKET_PAYOUTS_CAVEAT);
  });
});

describe("portfolioReturnsView", () => {
  const buy = (assetId: string, units: string, price: string, at: string) =>
    op("buy", units, price, at, assetId);
  /** Las dos mitades de un par comparten `transferId` (ADR 0082). */
  const transferOut = (
    assetId: string,
    units: string,
    price: string,
    at: string,
    transferId = "trf_1",
  ) => op("transfer_out", units, price, at, assetId, { transferId });
  const transferIn = (
    assetId: string,
    units: string,
    price: string,
    at: string,
    transferId = "trf_1",
  ) => op("transfer_in", units, price, at, assetId, { transferId });

  test("suma las carteras de todo el libro en una sola vista de mercado", () => {
    const view = portfolioReturnsView({
      operationsByAsset: new Map([
        ["a1", [buy("a1", "10", "100", "2024-01-01")]],
        ["a2", [buy("a2", "5", "200", "2024-01-01")]],
      ]),
      cachedPriceByAsset: new Map([
        ["a1", "150"],
        ["a2", "200"],
      ]),
      manualPriceByAsset: new Map(),
      monthlyClosesByAsset: new Map([
        [
          "a1",
          [
            { date: "2024-01-31", valueMinor: 100_000 },
            { date: "2026-07-04", valueMinor: 150_000 },
          ],
        ],
        [
          "a2",
          [
            { date: "2024-01-31", valueMinor: 100_000 },
            { date: "2026-07-04", valueMinor: 100_000 },
          ],
        ],
      ]),
      currency: "EUR",
      valuationDate: "2026-07-04",
    });

    expect(view).not.toBeNull();
    expect(view!.kind).toBe("market");
    // invertido 1.000 + 1.000 = 2.000; valor 1.500 + 1.000 = 2.500 → +25 %.
    expect(view!.totalReturnRatio).toBeCloseTo(0.25, 6);
    expect(view!.twr!.rate).toBeCloseTo(0.25, 6);
  });

  test("un par de traspaso interno no infla lo invertido, y mide lo que subsetReturns (#1592)", () => {
    // 1.000 € comprados en a1; un año después a1 se traspasa entero a a2, ya
    // valiendo 1.100 €. El libro no recibió un euro más de fuera: el invertido
    // sigue siendo 1.000 €, nunca los ~2.100 € que sumaba el fold viejo.
    const operationsByAsset = new Map([
      [
        "a1",
        [
          buy("a1", "10", "100", "2024-01-01"),
          transferOut("a1", "10", "110", "2025-01-01"),
        ],
      ],
      ["a2", [transferIn("a2", "10", "110", "2025-01-01")]],
    ]);
    const view = portfolioReturnsView({
      operationsByAsset,
      // a1 quedó a cero; a2 vale hoy 1.200 €.
      cachedPriceByAsset: new Map([
        ["a1", "0"],
        ["a2", "120"],
      ]),
      manualPriceByAsset: new Map(),
      currency: "EUR",
      valuationDate: "2026-01-01",
    });

    // El careo que pide el ticket: la cifra del hero es la del motor, no una suya.
    const engine = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: operationsByAsset.get("a1")!,
        },
        {
          marketValueMinor: 120_000,
          monthlyCloses: [],
          operations: operationsByAsset.get("a2")!,
        },
      ],
      valuationDate: "2026-01-01",
    });

    expect(view!.totalReturnRatio).toBeCloseTo(0.2, 10);
    expect(view!.totalGain).toEqual(money(20_000, "EUR"));
    expect(view!.totalReturnRatio).toBe(engine.simpleGain.totalReturnRatio);
    expect(view!.totalGain).toEqual(engine.simpleGain.totalGain);
    expect(view!.irr).toEqual(engine.irr);
  });

  test("una mitad cuya contraparte vive fuera del libro medido sigue siendo capital que entra", () => {
    // a2 recibe un traspaso cuyo origen no tiene operaciones en el libro (una
    // cartera mirror, un alta sin ledger): no hay par que anular, así que los
    // 1.100 € que entran son capital de verdad.
    const view = portfolioReturnsView({
      operationsByAsset: new Map([["a2", [transferIn("a2", "10", "110", "2025-01-01")]]]),
      cachedPriceByAsset: new Map([["a2", "120"]]),
      manualPriceByAsset: new Map(),
      currency: "EUR",
      valuationDate: "2026-01-01",
    });

    // 1.200 − 1.100 = 100 € sobre 1.100 invertidos.
    expect(view!.totalGain).toEqual(money(10_000, "EUR"));
    expect(view!.totalReturnRatio).toBeCloseTo(10_000 / 110_000, 10);
  });

  test("dos movimientos independientes del mismo día no se cancelan", () => {
    // Vender un fondo y comprar otro el mismo día no es un traspaso: sin
    // `transferId` que los empareje, los dos flujos son reales.
    const view = portfolioReturnsView({
      operationsByAsset: new Map([
        [
          "a1",
          [
            buy("a1", "10", "100", "2024-01-01"),
            op("sell", "10", "110", "2025-01-01", "a1"),
          ],
        ],
        ["a2", [buy("a2", "10", "110", "2025-01-01")]],
      ]),
      cachedPriceByAsset: new Map([
        ["a1", "0"],
        ["a2", "120"],
      ]),
      manualPriceByAsset: new Map(),
      currency: "EUR",
      valuationDate: "2026-01-01",
    });

    // El denominador se queda entero — 1.000 + 1.100 aportados — porque ninguno
    // de los dos flujos es la mitad de un par: contrástese con el traspaso de
    // arriba, donde el mismo movimiento SÍ colapsa a los 1.000 € originales.
    expect(view!.totalGain).toEqual(money(20_000, "EUR"));
    expect(view!.totalReturnRatio).toBeCloseTo(20_000 / 210_000, 10);
  });

  test("una tenencia sin precio entra por su coste, nunca arrastrando el libro (#1314)", () => {
    const view = portfolioReturnsView({
      operationsByAsset: new Map([
        ["a1", [buy("a1", "10", "100", "2024-01-01")]],
        ["a2", [buy("a2", "10", "100", "2024-01-01")]],
      ]),
      // a2 es el alta cuya primera cotización no ha aterrizado: aporta su coste,
      // no cero — el libro entero leería −50 %.
      cachedPriceByAsset: new Map([["a1", "100"]]),
      manualPriceByAsset: new Map(),
      currency: "EUR",
      valuationDate: "2026-07-04",
    });

    expect(view!.totalReturnRatio).toBe(0);
    expect(view!.totalGain).toEqual(money(0, "EUR"));
  });

  test("es null cuando no hay ninguna tenencia con operaciones", () => {
    expect(
      portfolioReturnsView({
        operationsByAsset: new Map(),
        cachedPriceByAsset: new Map(),
        manualPriceByAsset: new Map(),
        currency: "EUR",
        valuationDate: "2026-07-04",
      }),
    ).toBeNull();
  });

  test("pliega los cobros registrados en la ganancia simple y en el IRR (#657)", () => {
    const view = portfolioReturnsView({
      operationsByAsset: new Map([["a1", [buy("a1", "10", "100", "2024-01-01")]]]),
      cachedPriceByAsset: new Map([["a1", "100"]]), // plano: valor == coste
      manualPriceByAsset: new Map(),
      payoutsByAsset: new Map([["a1", [{ amountMinor: 50_000, date: "2025-01-01" }]]]),
      currency: "EUR",
      valuationDate: "2026-07-04",
    });

    expect(view!.totalGain).toEqual(money(500_00, "EUR"));
    // Un libro plano con 500 € cobrados tiene un IRR positivo: el cobro está dentro.
    expect(view!.irr!.rate).toBeGreaterThan(0);
    expect(view!.caveats).toContain(MARKET_PAYOUTS_CAVEAT);
  });

  test("el TWR alinea los cierres por mes, no por fecha exacta (#1457)", () => {
    // Los dos cierres de enero caen en días distintos, y los dos de febrero
    // también. Unidos por fecha exacta, cada día sería una suma parcial del libro
    // — el diente de sierra. Alineados por mes son dos puntos: 2.000 → 2.200.
    const view = portfolioReturnsView({
      operationsByAsset: new Map([
        ["a1", [buy("a1", "10", "100", "2023-06-01")]],
        ["a2", [buy("a2", "10", "100", "2023-06-01")]],
      ]),
      cachedPriceByAsset: new Map([
        ["a1", "110"],
        ["a2", "110"],
      ]),
      manualPriceByAsset: new Map(),
      monthlyClosesByAsset: new Map([
        [
          "a1",
          [
            { date: "2024-01-31", valueMinor: 100_000 },
            { date: "2024-02-29", valueMinor: 110_000 },
          ],
        ],
        [
          "a2",
          [
            { date: "2024-01-30", valueMinor: 100_000 },
            { date: "2024-02-28", valueMinor: 110_000 },
          ],
        ],
      ]),
      currency: "EUR",
      valuationDate: "2024-03-01",
    });

    expect(view!.twr!.rate).toBeCloseTo(0.1, 10);
    expect(view!.twr!.startDate).toBe("2024-01-31");
  });

  test("sin cierres mensuales el hero no publica un TWR", () => {
    const view = portfolioReturnsView({
      operationsByAsset: new Map([["a1", [buy("a1", "10", "100", "2024-01-01")]]]),
      cachedPriceByAsset: new Map([["a1", "110"]]),
      manualPriceByAsset: new Map(),
      currency: "EUR",
      valuationDate: "2026-07-04",
    });

    expect(view!.twr).toBeNull();
  });
});

describe("returnsByAssetClassView", () => {
  test("frames each class as a market view carrying the class-attribution caveat", () => {
    const result = returnsByAssetClassView({
      assetClassByAsset: new Map([
        ["a1", { breakdown: { equity: "1" }, kind: "classified" }],
        ["a2", { breakdown: { bond: "1" }, kind: "classified" }],
      ]),
      cachedPriceByAsset: new Map([
        ["a1", "150"],
        ["a2", "200"],
      ]),
      currency: "EUR",
      instrumentByAsset: new Map([
        ["a1", "fund"],
        ["a2", "fund"],
      ]),
      manualPriceByAsset: new Map(),
      operationsByAsset: new Map([
        ["a1", [op("buy", "10", "100", "2024-01-01", "a1")]],
        ["a2", [op("buy", "5", "200", "2024-01-01", "a2")]],
      ]),
      valuationDate: "2026-07-04",
    });

    expect(result).not.toBeNull();
    expect(result!.classes.map((c) => c.key).sort()).toEqual(["bond", "equity"]);
    const equity = result!.classes.find((c) => c.key === "equity")!;
    expect(equity.view.kind).toBe("market");
    // a1: invested 1000, value 1500 → +50%.
    expect(equity.view.totalReturnRatio).toBeCloseTo(0.5, 6);
    expect(equity.view.caveats).toContain(CLASS_ATTRIBUTION_CAVEAT);
    expect(equity.value.amountMinor).toBe(150_000);
    expect(result!.coverage.unknown.amountMinor).toBe(0);
  });

  test("the payout caveat is per-class — only classes that received a payout claim it (#657)", () => {
    const result = returnsByAssetClassView({
      assetClassByAsset: new Map([
        ["a1", { breakdown: { equity: "1" }, kind: "classified" }],
        ["a2", { breakdown: { bond: "1" }, kind: "classified" }],
      ]),
      cachedPriceByAsset: new Map([
        ["a1", "100"], // flat
        ["a2", "200"],
      ]),
      currency: "EUR",
      instrumentByAsset: new Map([
        ["a1", "fund"],
        ["a2", "fund"],
      ]),
      manualPriceByAsset: new Map(),
      operationsByAsset: new Map([
        ["a1", [op("buy", "10", "100", "2024-01-01", "a1")]],
        ["a2", [op("buy", "5", "200", "2024-01-01", "a2")]],
      ]),
      // Only the equity fund distributes; the bond fund does not.
      payoutsByAsset: new Map([["a1", [{ amountMinor: 50_000, date: "2025-01-01" }]]]),
      valuationDate: "2026-07-04",
    });

    const equity = result!.classes.find((c) => c.key === "equity")!;
    expect(equity.view.totalGain).toEqual(money(500_00, "EUR"));
    expect(equity.view.caveats).toContain(MARKET_PAYOUTS_CAVEAT);
    expect(equity.view.caveats).toContain(CLASS_ATTRIBUTION_CAVEAT);

    // The bond class saw no payout, so it must not claim one.
    const bond = result!.classes.find((c) => c.key === "bond")!;
    expect(bond.view.caveats).toContain(MARKET_CAVEAT);
    expect(bond.view.caveats).not.toContain(MARKET_PAYOUTS_CAVEAT);
  });

  test("a holding whose class is unknown lands in the unclassified bucket", () => {
    const result = returnsByAssetClassView({
      assetClassByAsset: new Map([["a1", { kind: "unknown" }]]),
      cachedPriceByAsset: new Map([["a1", "150"]]),
      currency: "EUR",
      instrumentByAsset: new Map([["a1", "fund"]]),
      manualPriceByAsset: new Map(),
      operationsByAsset: new Map([["a1", [op("buy", "10", "100", "2024-01-01", "a1")]]]),
      valuationDate: "2026-07-04",
    });

    expect(result!.classes.map((c) => c.key)).toEqual(["unclassified"]);
    expect(result!.coverage.unknown.amountMinor).toBe(150_000);
    expect(result!.coverage.classified.amountMinor).toBe(0);
  });

  test("is null when no operation-bearing market holding resolves", () => {
    expect(
      returnsByAssetClassView({
        assetClassByAsset: new Map(),
        cachedPriceByAsset: new Map(),
        currency: "EUR",
        instrumentByAsset: new Map(),
        manualPriceByAsset: new Map(),
        operationsByAsset: new Map(),
        valuationDate: "2026-07-04",
      }),
    ).toBeNull();
  });
});
