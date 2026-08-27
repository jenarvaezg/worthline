import { describe, expect, test } from "vitest";

import type { InvestmentOperation, OperationKind } from "./investment-types";
import type { MonthlyCloseValue } from "./returns";
import { xirr } from "./returns";
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

/**
 * Dos miembros de vida desigual: 100,00 € invertidos en 2021 que valen 133,10 €, y
 * 200,00 € invertidos un año después que valen 220,00 €. Invertido 300,00 €, valor
 * 353,10 €, y una vida medida que arranca en el flujo más antiguo de los dos.
 */
const MEMBERS_BOUGHT_A_YEAR_APART = [
  {
    marketValueMinor: 13_310,
    monthlyCloses: [],
    operations: [buy("100", "1", "2021-01-01")],
  },
  {
    marketValueMinor: 22_000,
    monthlyCloses: [],
    operations: [buy("100", "2", "2022-01-01")],
  },
];

describe("subsetReturns", () => {
  test("suma lo invertido y la ganancia de todos los miembros", () => {
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 130_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2023-01-01")],
        },
        {
          marketValueMinor: 55_000,
          monthlyCloses: [],
          operations: [buy("5", "100", "2023-06-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    // Invertidos 1.000 + 500; valor 1.300 + 550 → 350 de ganancia sobre 1.500.
    expect(result.marketValueMinor).toBe(185_000);
    expect(result.simpleGain.totalInvestedMinor).toBe(150_000);
    expect(result.simpleGain.totalGain).toEqual({
      amountMinor: 35_000,
      currency: "EUR",
    });
    expect(result.simpleGain.totalReturnRatio).toBeCloseTo(35_000 / 150_000, 10);
  });

  test("el IRR es el de la corriente de flujos de todos los miembros unida", () => {
    const reference = xirr([
      { amountMinor: -10_000, date: "2021-01-01" },
      { amountMinor: -20_000, date: "2022-01-01" },
      { amountMinor: 13_310, date: "2024-01-01" },
      { amountMinor: 22_000, date: "2024-01-01" },
    ]);

    const result = subsetReturns({
      currency: "EUR",
      slices: MEMBERS_BOUGHT_A_YEAR_APART,
      valuationDate: "2024-01-01",
    });

    expect(result.irr.reason).toBeNull();
    expect(reference.rate).not.toBeNull();
    expect(result.irr.rate).toBeCloseTo(reference.rate as number, 8);
  });

  test("el CAGR arranca en el flujo más antiguo del subconjunto, no en el del último miembro", () => {
    const result = subsetReturns({
      currency: "EUR",
      slices: MEMBERS_BOUGHT_A_YEAR_APART,
      valuationDate: "2024-01-01",
    });

    // 2021-01-01 → 2024-01-01: 1.095 días, tres años de vida medida.
    expect(result.simpleGain.spanDays).toBe(1_095);
    expect(result.simpleGain.annualized).toBe(true);
    expect(result.simpleGain.cagr).toBeCloseTo(
      (1 + 5_310 / 30_000) ** (365 / 1_095) - 1,
      10,
    );
  });

  test("traspasar dentro del subconjunto no cambia su rentabilidad", () => {
    // La misma vida medida, contada de dos formas: un fondo comprado en 2025 que
    // sigue ahí, y ese mismo fondo traspasado a otro miembro a mitad de camino.
    const paired = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [
            buy("10", "100", "2025-01-01"),
            transferOut("10", "110", "2026-01-01"),
          ],
        },
        {
          marketValueMinor: 121_000,
          monthlyCloses: [],
          operations: [transferIn("10", "110", "2026-01-01")],
        },
      ],
      valuationDate: "2027-01-01",
    });
    const untouched = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 121_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2025-01-01")],
        },
      ],
      valuationDate: "2027-01-01",
    });

    expect(paired.simpleGain).toEqual(untouched.simpleGain);
    expect(paired.irr.reason).toBeNull();
    expect(paired.irr.rate).toBeCloseTo(untouched.irr.rate as number, 10);
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

  test("los flujos del TWR se escalan como el resto: un aporte a medias pesa la mitad", () => {
    // El único escenario que el fold viejo de cartera medía y que aquí faltaba: un
    // miembro con cierres Y operaciones. Sin el escalado, Modified Dietz leería un
    // aporte bruto de 1.000 € contra una serie que solo refleja la mitad poseída, y
    // el tramo se hundiría.
    const result = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 170_000,
          // Ya en base titularidad, como exige el contrato de la slice.
          monthlyCloses: [
            { date: "2024-01-31", valueMinor: 100_000 },
            { date: "2024-02-29", valueMinor: 170_000 },
          ],
          operations: [buy("10", "100", "2024-02-15")], // 1.000 € brutos
          ownershipBps: 5_000, // la mitad: el flujo del TWR vale 500 €
        },
      ],
      valuationDate: "2024-02-29",
    });

    // Modified Dietz pondera los 500 € por sus 14 días de los 29 de febrero.
    expect(result.twr.reason).toBeNull();
    expect(result.twr.rate).toBeCloseTo(20_000 / (100_000 + 50_000 * (14 / 29)), 10);
  });

  test("un traspaso interno tampoco deja escalón en el TWR, aunque las mitades liquiden en días distintos", () => {
    // El par se anula en la rama del TWR igual que en la del IRR, y por `transferId`
    // (ADR 0082), no por fecha: las dos mitades pueden liquidar días aparte. Si
    // entrasen sueltas, Modified Dietz las ponderaría por días DISTINTOS y no se
    // anularían en el denominador — leería como movimiento de capital lo que no
    // movió un céntimo fuera del subconjunto.
    const closes = (january: number, february: number) => [
      { date: "2024-01-31", valueMinor: january },
      { date: "2024-02-29", valueMinor: february },
    ];

    const paired = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 60_000,
          monthlyCloses: closes(100_000, 60_000),
          operations: [transferOut("5", "110", "2024-02-05")],
        },
        {
          marketValueMinor: 75_000,
          monthlyCloses: closes(20_000, 75_000),
          // Quince días después: el dinero tarda en aterrizar en el destino.
          operations: [transferIn("5", "110", "2024-02-20")],
        },
      ],
      valuationDate: "2024-02-29",
    });
    const untouched = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 135_000,
          monthlyCloses: closes(120_000, 135_000),
          operations: [],
        },
      ],
      valuationDate: "2024-02-29",
    });

    // 1.200 € → 1.350 € de puro precio: el mismo tramo, con traspaso y sin él.
    expect(paired.twr.reason).toBeNull();
    expect(paired.twr.rate).toBeCloseTo(0.125, 10);
    expect(paired.twr.rate).toBeCloseTo(untouched.twr.rate as number, 10);
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
    // Un miembro plano no gana nada por sí solo: el cobro es toda su rentabilidad.
    expect(result.irr.reason).toBeNull();
    expect(result.irr.rate as number).toBeGreaterThan(0);
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
