import { describe, expect, test } from "vitest";

import type { InvestmentOperation, OperationKind } from "./investment-types";
import type { MonthlyCloseValue } from "./returns";
import { portfolioSimpleGain } from "./returns";
import { subsetReturns } from "./returns-subset";

function op(
  kind: OperationKind,
  units: string,
  pricePerUnit: string,
  executedAt: string,
  extra: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId: "asset_inv",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${kind}_${executedAt}_${units}`,
    kind,
    pricePerUnit,
    units,
    ...extra,
  };
}

const buy = (units: string, price: string, at: string) => op("buy", units, price, at);
const sell = (units: string, price: string, at: string) => op("sell", units, price, at);
/** Las dos mitades comparten `transferId`: es lo que las hace un par (ADR 0082). */
const transferOut = (units: string, price: string, at: string, transferId = "trf_1") =>
  op("transfer_out", units, price, at, { transferId });
const transferIn = (units: string, price: string, at: string, transferId = "trf_1") =>
  op("transfer_in", units, price, at, { transferId });

describe("subsetReturns", () => {
  test("un subconjunto sin traspasos mide lo mismo que la agregación de cartera", () => {
    const holdings = [
      { marketValueMinor: 130_000, operations: [buy("10", "100", "2023-01-01")] },
      { marketValueMinor: 55_000, operations: [buy("5", "100", "2023-06-01")] },
    ];

    const result = subsetReturns({
      currency: "EUR",
      slices: holdings.map((holding) => ({ ...holding, monthlyCloses: [] })),
      valuationDate: "2024-06-01",
    });
    const expected = portfolioSimpleGain({
      currency: "EUR",
      holdings,
      valuationDate: "2024-06-01",
    });

    expect(result.marketValueMinor).toBe(185_000);
    expect(result.simpleGain.totalInvestedMinor).toBe(expected.totalInvestedMinor);
    expect(result.simpleGain.totalGain.amountMinor).toBe(expected.totalGain.amountMinor);
  });

  test("un traspaso entre dos miembros se cancela en su fecha: no infla lo invertido", () => {
    // 1.000 € comprados en A; un año después A se traspasa entero a B, ya valiendo
    // 1.100 €. El capital que el subconjunto recibió de fuera sigue siendo 1.000 €,
    // así que la rentabilidad se mide sobre esos 1.000, no sobre 2.100.
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [
            buy("10", "100", "2023-01-01"),
            transferOut("10", "110", "2024-01-01"),
          ],
        },
        {
          marketValueMinor: 120_000,
          monthlyCloses: [],
          operations: [transferIn("10", "110", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.simpleGain.totalInvestedMinor).toBe(100_000);
    expect(result.simpleGain.totalGain.amountMinor).toBe(20_000);
    expect(result.simpleGain.totalReturnRatio).toBeCloseTo(0.2, 10);
  });

  test("el par asimétrico deja como flujo solo lo que la comisión se llevó", () => {
    // Los dos importes de un par pueden diferir (la comisión de salida): lo que no
    // se cancela es exactamente esa diferencia, nunca el traspaso entero.
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [
            buy("10", "100", "2023-01-01"),
            op("transfer_out", "10", "110", "2024-01-01", {
              feesMinor: 500,
              transferId: "trf_1",
            }),
          ],
        },
        {
          marketValueMinor: 110_000,
          monthlyCloses: [],
          operations: [transferIn("10", "109.5", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    // Sale 1.095 (1.100 − 5 de comisión) y entra 1.095: nada que sumar al invertido.
    expect(result.simpleGain.totalInvestedMinor).toBe(100_000);
    expect(result.simpleGain.totalGain.amountMinor).toBe(10_000);
  });

  test("dos movimientos independientes del mismo día NO se cancelan", () => {
    // Vender un fondo y comprar otro el mismo día no es un traspaso: son dos
    // decisiones, y el subconjunto devolvió dinero y recibió dinero de verdad.
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [buy("10", "100", "2023-01-01"), sell("10", "110", "2024-01-01")],
        },
        {
          marketValueMinor: 115_000,
          monthlyCloses: [],
          operations: [buy("10", "110", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.simpleGain.totalInvestedMinor).toBe(210_000);
    expect(result.sellProceedsMinor).toBe(110_000);
  });

  test("media mitad no cancela: la contraparte vive fuera del subconjunto", () => {
    // Un fondo traspasado FUERA de la cartera es capital que se va, no un
    // movimiento interno — y contarlo como interno le quitaría la salida.
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [
            buy("10", "100", "2023-01-01"),
            transferOut("10", "110", "2024-01-01"),
          ],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.simpleGain.totalInvestedMinor).toBe(100_000);
    expect(result.simpleGain.totalGain.amountMinor).toBe(10_000);
    expect(result.sellProceedsMinor).toBe(110_000);
  });

  test("los cobros no cuentan como reembolsos", () => {
    // Un dividendo entra en la ganancia, pero no es una venta: una superficie que
    // diga «ha habido reembolsos» no puede decirlo por un cobro registrado.
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2023-01-01")],
          payouts: [{ amountMinor: 3_000, date: "2023-07-01" }],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.sellProceedsMinor).toBe(0);
  });

  test("el doble escalado: la titularidad escala los flujos, la participación todo", () => {
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 25_000, // ya escalado por el llamante (50% de 50k)
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")], // 100k brutos
          ownershipBps: 5_000,
          shareBps: 5_000,
        },
      ],
      valuationDate: "2024-06-01",
    });

    // 100k × 50% titularidad × 50% participación = 25k invertidos, contra 25k de valor.
    expect(result.simpleGain.totalInvestedMinor).toBe(25_000);
    expect(result.marketValueMinor).toBe(12_500);
  });

  test("una posición sin cierres mensuales no aporta ni serie ni flujo al TWR", () => {
    const closes: MonthlyCloseValue[] = [
      { date: "2023-01-31", valueMinor: 100_000 },
      { date: "2023-12-31", valueMinor: 110_000 },
    ];

    const result = subsetReturns({
      currency: "EUR",
      slices: [
        { marketValueMinor: 110_000, monthlyCloses: closes, operations: [] },
        {
          // Un alta de hoy: su compra sin valor detrás hundiría el tramo (#1457).
          marketValueMinor: 500_000,
          monthlyCloses: [],
          operations: [buy("50", "100", "2023-12-31")],
        },
      ],
      valuationDate: "2023-12-31",
    });

    expect(result.twr.rate).toBeCloseTo(0.1, 10);
  });

  test("los cierres se alinean por mes, no por fecha exacta", () => {
    // Dos miembros que cierran el mismo mes en días distintos: sumar por fecha
    // exacta alternaría entre «toda la cartera» y «un miembro» (#1457).
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 60_000,
          monthlyCloses: [
            { date: "2023-01-31", valueMinor: 50_000 },
            { date: "2023-02-28", valueMinor: 60_000 },
          ],
          operations: [],
        },
        {
          marketValueMinor: 40_000,
          monthlyCloses: [
            { date: "2023-01-30", valueMinor: 50_000 },
            { date: "2023-02-27", valueMinor: 40_000 },
          ],
          operations: [],
        },
      ],
      valuationDate: "2023-02-28",
    });

    // 100.000 → 100.000: plano, no un diente de sierra.
    expect(result.twr.rate).toBeCloseTo(0, 10);
  });

  test("los cobros registrados entran en la ganancia y se declaran", () => {
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2023-01-01")],
          payouts: [{ amountMinor: 3_000, date: "2023-07-01" }],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.payoutsIncluded).toBe(true);
    expect(result.simpleGain.totalGain.amountMinor).toBe(3_000);
  });

  test("sin miembros no hay medida que fabricar", () => {
    const result = subsetReturns({
      currency: "EUR",
      slices: [],
      valuationDate: "2024-06-01",
    });

    expect(result.marketValueMinor).toBe(0);
    expect(result.simpleGain.totalReturnRatio).toBeNull();
    expect(result.irr.rate).toBeNull();
    expect(result.twr.rate).toBeNull();
  });
});
