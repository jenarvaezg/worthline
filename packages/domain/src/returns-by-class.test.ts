import { describe, expect, test } from "vitest";

import type { AssetClassResolution, ExposureProfile } from "./exposure-lookthrough";
import { lookThroughExposure } from "./exposure-lookthrough";
import type { InvestmentOperation, OperationKind } from "./investment-types";
import type { MonthlyCloseValue } from "./returns";
import { returnsByAssetClass, UNCLASSIFIED_ASSET_CLASS_KEY } from "./returns-by-class";
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

const buy = (
  units: string,
  price: string,
  at: string,
  extra: Partial<InvestmentOperation> = {},
) => op("buy", units, price, at, extra);
const sell = (
  units: string,
  price: string,
  at: string,
  extra: Partial<InvestmentOperation> = {},
) => op("sell", units, price, at, extra);

const classified = (breakdown: Record<string, string>): AssetClassResolution => ({
  breakdown,
  kind: "classified",
});
const unknown: AssetClassResolution = { kind: "unknown" };

describe("returnsByAssetClass", () => {
  test("a single holding fully in one class reports that class alone, matching the subset taken whole", () => {
    const operations = [buy("10", "100", "2023-01-01")];
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 130_000,
          monthlyCloses: [],
          operations,
        },
      ],
      valuationDate: "2024-01-01",
    });

    expect(result.classes).toHaveLength(1);
    const equity = result.classes[0]!;
    expect(equity.key).toBe("equity");
    expect(equity.value).toEqual({ amountMinor: 130_000, currency: "EUR" });

    // A 100% class weight scales nothing away: the class measures what the subset
    // taken whole measures, over the same holding.
    const whole = subsetReturns({
      currency: "EUR",
      slices: [{ marketValueMinor: 130_000, monthlyCloses: [], operations }],
      valuationDate: "2024-01-01",
    });
    expect(equity.simpleGain.totalGain).toEqual({
      amountMinor: 30_000,
      currency: "EUR",
    });
    expect(equity.simpleGain.totalGain).toEqual(whole.simpleGain.totalGain);
    expect(equity.irr.rate).toBeCloseTo(whole.irr.rate!, 6);
    expect(result.coverage.unknown.amountMinor).toBe(0);
    expect(result.coverage.classified.amountMinor).toBe(130_000);
  });

  test("a 60/40 fund splits its value, cost and flows fractionally across the two classes", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ bond: "0.4", equity: "0.6" }),
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")], // invested 100_000
        },
      ],
      valuationDate: "2024-06-01",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    const bond = result.classes.find((c) => c.key === "bond")!;
    expect(equity.value.amountMinor).toBe(60_000);
    expect(bond.value.amountMinor).toBe(40_000);
    expect(equity.simpleGain.totalInvestedMinor).toBe(60_000);
    expect(bond.simpleGain.totalInvestedMinor).toBe(40_000);
    // Both slices are break-even (value == cost), so ratio is 0 for each.
    expect(equity.simpleGain.totalReturnRatio).toBe(0);
    expect(bond.simpleGain.totalReturnRatio).toBe(0);
    // Attribution is exhaustive: the class values sum back to the holding value.
    expect(equity.value.amountMinor + bond.value.amountMinor).toBe(100_000);
  });

  test("a breakdown declaring under 100% sends the remainder to `other`", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "0.7" }),
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("1", "1000", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.classes.map((c) => c.key).sort()).toEqual(["equity", "other"]);
    expect(result.classes.find((c) => c.key === "equity")!.value.amountMinor).toBe(
      70_000,
    );
    expect(result.classes.find((c) => c.key === "other")!.value.amountMinor).toBe(30_000);
    // `other` is a declared remainder, not a coverage gap.
    expect(result.coverage.unknown.amountMinor).toBe(0);
    expect(result.coverage.classified.amountMinor).toBe(100_000);
  });

  test("a holding with no resolvable class falls whole into `unclassified` and counts as unknown coverage", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 60_000,
          monthlyCloses: [],
          operations: [buy("1", "500", "2024-01-01")],
        },
        {
          assetClass: unknown,
          marketValueMinor: 40_000,
          monthlyCloses: [],
          operations: [buy("1", "300", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    const unclassified = result.classes.find(
      (c) => c.key === UNCLASSIFIED_ASSET_CLASS_KEY,
    )!;
    expect(unclassified.value.amountMinor).toBe(40_000);
    expect(unclassified.simpleGain.totalInvestedMinor).toBe(30_000);
    expect(result.coverage.classified.amountMinor).toBe(60_000);
    expect(result.coverage.unknown.amountMinor).toBe(40_000);
  });

  test("classes are sorted by attributed value descending, then key", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ bond: "0.3", equity: "0.7" }),
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("1", "1000", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    expect(result.classes.map((c) => c.key)).toEqual(["equity", "bond"]);
  });

  test("ownershipBps scales only the operation cashflows, so a co-owned holding's slice is coherent with its scoped value", () => {
    // 50%-owned: caller passes the scoped value (50k of a 100k gross holding) and
    // ownershipBps=5000. Operations (gross 100k invested) must be scaled to 50k so
    // simple gain reads break-even, not a fabricated −50%.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 50_000, // scoped ownedMinor
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")], // gross invested 100_000
          ownershipBps: 5_000,
        },
      ],
      valuationDate: "2024-06-01",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    expect(equity.simpleGain.totalInvestedMinor).toBe(50_000);
    expect(equity.simpleGain.totalGain.amountMinor).toBe(0);
    expect(equity.simpleGain.totalReturnRatio).toBe(0);
  });

  test("un traspaso entre dos fondos de la misma clase no infla lo invertido de la clase", () => {
    // Las dos mitades caen en el mismo bucket el mismo día (ADR 0082): son dinero
    // moviéndose DENTRO de la clase, no capital nuevo que la clase recibiera.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [
            buy("10", "100", "2023-01-01"),
            op("transfer_out", "10", "110", "2024-01-01", { transferId: "trf_1" }),
          ],
        },
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 120_000,
          monthlyCloses: [],
          operations: [
            op("transfer_in", "10", "110", "2024-01-01", { transferId: "trf_1" }),
          ],
        },
      ],
      valuationDate: "2024-06-01",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    expect(equity.simpleGain.totalInvestedMinor).toBe(100_000);
    expect(equity.simpleGain.totalReturnRatio).toBeCloseTo(0.2, 10);
  });

  test("per-class TWR chains the class-weighted monthly closes with no cashflows", () => {
    const monthlyCloses: MonthlyCloseValue[] = [
      { date: "2023-01-31", valueMinor: 100_000 },
      { date: "2023-12-31", valueMinor: 110_000 },
    ];
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          // fully equity, but only 50% of its value is measured on the equity slice
          assetClass: classified({ equity: "0.5" }),
          marketValueMinor: 110_000,
          monthlyCloses,
          operations: [buy("1", "1000", "2023-01-15")],
        },
      ],
      valuationDate: "2024-01-15",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Scaling every close by the same weight leaves the pure price move unchanged:
    // (55_000 − 50_000) / 50_000 = +10%.
    expect(equity.twr.reason).toBeNull();
    expect(equity.twr.rate).toBeCloseTo(0.1, 6);
  });

  test("a payout folds into the class simple gain, reconciling with the subset taken whole", () => {
    const operations = [buy("10", "100", "2023-01-01")]; // invested 100_000
    const payouts = [{ amountMinor: 50_000, date: "2023-06-01" }];
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 100_000, // flat: value == cost
          monthlyCloses: [],
          operations,
          payouts,
        },
      ],
      valuationDate: "2024-01-01",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Flat holding: the whole gain is the recorded distribution.
    expect(equity.simpleGain.totalGain.amountMinor).toBe(50_000);
    expect(equity.simpleGain).toEqual(
      subsetReturns({
        currency: "EUR",
        slices: [{ marketValueMinor: 100_000, monthlyCloses: [], operations, payouts }],
        valuationDate: "2024-01-01",
      }).simpleGain,
    );
  });

  test("a payout is scaled by ownership then class weight", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ bond: "0.4", equity: "0.6" }),
          marketValueMinor: 50_000, // owned slice, flat
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")], // gross invested 100_000
          ownershipBps: 5_000, // owner holds half
          payouts: [{ amountMinor: 100_000, date: "2024-06-01" }],
        },
      ],
      valuationDate: "2024-12-01",
    });

    // 100_000 × 50% ownership × 60% equity = 30_000 attributed to equity.
    const equity = result.classes.find((c) => c.key === "equity")!;
    expect(equity.simpleGain.totalGain.amountMinor).toBe(30_000);
    // 100_000 × 50% × 40% bond = 20_000.
    const bond = result.classes.find((c) => c.key === "bond")!;
    expect(bond.simpleGain.totalGain.amountMinor).toBe(20_000);
  });
});

describe("la serie de la clase se alinea antes de medirla (#1457)", () => {
  test("dos holdings que cierran en fechas distintas miden como la serie alineada", () => {
    // La captura diaria es best-effort (#1339): dos holdings de la misma clase
    // pueden cerrar el mes en días distintos. Unir por fecha exacta convertía la
    // serie en dientes de sierra entre «toda la clase» y «un holding».
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 110_000,
          monthlyCloses: [
            { date: "2025-11-30", valueMinor: 100_000 },
            { date: "2025-12-31", valueMinor: 110_000 },
          ],
          operations: [buy("10", "100", "2025-10-01")],
        },
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 55_000,
          monthlyCloses: [
            { date: "2025-11-29", valueMinor: 50_000 },
            { date: "2025-12-30", valueMinor: 55_000 },
          ],
          operations: [buy("5", "100", "2025-10-01", { assetId: "asset_b" })],
        },
      ],
      valuationDate: "2026-01-15",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Alineada: nov = 150.000, dic = 165.000 → +10%, sin flujos en el tramo.
    expect(equity.twr.reason).toBeNull();
    expect(equity.twr.rate).toBeCloseTo(0.1, 10);
    expect(equity.twr.startDate).toBe("2025-11-30");
    expect(equity.twr.endDate).toBe("2025-12-31");
  });

  test("un mes sin cierre para un holding arrastra su último valor conocido", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 120_000,
          monthlyCloses: [
            { date: "2025-10-31", valueMinor: 100_000 },
            { date: "2025-11-30", valueMinor: 110_000 },
            { date: "2025-12-31", valueMinor: 120_000 },
          ],
          operations: [buy("10", "100", "2025-09-01")],
        },
        {
          // La pasada de noviembre se perdió (#1339): sin cierre ese mes.
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 100_000,
          monthlyCloses: [
            { date: "2025-10-31", valueMinor: 50_000 },
            { date: "2025-12-31", valueMinor: 100_000 },
          ],
          operations: [
            buy("5", "100", "2025-09-01", { assetId: "asset_b" }),
            buy("5", "100", "2025-12-20", { assetId: "asset_b" }),
          ],
        },
      ],
      valuationDate: "2026-01-15",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Alineada: oct = 150.000, nov = 160.000 (B arrastra su cierre de octubre),
    // dic = 220.000, con la aportación de 50.000 el 20/12 dentro del tramo.
    const december = 10_000 / (160_000 + 50_000 * (11 / 31));
    expect(equity.twr.reason).toBeNull();
    expect(equity.twr.rate).toBeCloseTo((160 / 150) * (1 + december) - 1, 10);
  });

  test("al holding que sigue en cartera no lo expulsa una pasada perdida al final", () => {
    // La señal de salida es no tener ya valor, no que a su serie le falte el
    // último cierre: si la pasada del último mes se perdió para él (#1339), el
    // holding sigue ahí y arrastra su último valor conocido.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 110_000,
          monthlyCloses: [
            { date: "2025-11-30", valueMinor: 100_000 },
            { date: "2025-12-31", valueMinor: 110_000 },
          ],
          operations: [buy("10", "100", "2025-10-01")],
        },
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 50_000, // sigue en cartera
          monthlyCloses: [{ date: "2025-11-30", valueMinor: 50_000 }],
          operations: [buy("5", "100", "2025-10-01", { assetId: "asset_b" })],
        },
      ],
      valuationDate: "2026-01-15",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Alineada: nov = 150.000, dic = 160.000 (B arrastra sus 50.000), sin flujos.
    expect(equity.twr.reason).toBeNull();
    expect(equity.twr.rate).toBeCloseTo(160 / 150 - 1, 10);
  });

  test("el caso reproducido deja de dar un imposible cuando la serie se alinea", () => {
    // materias primas, nov–dic 2025: dos holdings de la clase cerrando en días
    // distintos convertían una aportación normal en un flujo gigante frente a un
    // valor artificialmente pequeño.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ commodity: "1" }),
          marketValueMinor: 999_00,
          monthlyCloses: [
            { date: "2025-11-28", valueMinor: 1_010_700 },
            { date: "2025-12-10", valueMinor: 99_900 },
          ],
          operations: [buy("1", "10107", "2025-10-01")],
        },
        {
          assetClass: classified({ commodity: "1" }),
          marketValueMinor: 620_000,
          monthlyCloses: [
            { date: "2025-11-30", valueMinor: 10_000 },
            { date: "2025-12-31", valueMinor: 620_000 },
          ],
          operations: [
            buy("1", "100", "2025-11-20", { assetId: "asset_b" }),
            buy("1", "6127", "2025-12-05", { assetId: "asset_b" }),
          ],
        },
      ],
      valuationDate: "2026-01-15",
    });

    const commodity = result.classes.find((c) => c.key === "commodity")!;
    expect(commodity.twr.reason).toBeNull();
    expect(commodity.twr.rate).not.toBeNull();
    expect(commodity.twr.rate as number).toBeGreaterThan(-1);
  });

  test("un holding vendido deja de aportar valor tras su último cierre", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 110_000,
          monthlyCloses: [
            { date: "2025-11-30", valueMinor: 100_000 },
            { date: "2025-12-31", valueMinor: 110_000 },
          ],
          operations: [buy("10", "100", "2025-10-01")],
        },
        {
          // Vendido a mitad de diciembre: su serie termina en noviembre.
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 0,
          monthlyCloses: [{ date: "2025-11-28", valueMinor: 50_000 }],
          operations: [
            buy("5", "100", "2025-10-01", { assetId: "asset_b" }),
            sell("5", "104", "2025-12-15", { assetId: "asset_b" }),
          ],
        },
      ],
      valuationDate: "2026-01-15",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // Serie 150.000 → 110.000 con una salida de 52.000 el 15/12, ponderada por
    // los 16 días que restan del tramo: Dietz absorbe el escalón de la venta.
    const weighted = -52_000 * (16 / 31);
    expect(equity.twr.reason).toBeNull();
    expect(equity.twr.rate).toBeCloseTo(
      (110_000 - 150_000 + 52_000) / (150_000 + weighted),
      10,
    );
  });

  test("un holding sin serie de cierres no aporta flujos a la TWR de la clase", () => {
    // Un alta de hoy todavía no aparece en ninguna captura (la pasada diaria aún
    // no ha corrido): sin valor en la serie, su compra sería un flujo enorme sin
    // contrapartida y hundiría la medida de toda la clase.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 110_000,
          monthlyCloses: [
            { date: "2025-11-30", valueMinor: 100_000 },
            { date: "2025-12-31", valueMinor: 110_000 },
          ],
          operations: [buy("10", "100", "2025-10-01")],
        },
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 500_000,
          monthlyCloses: [],
          operations: [buy("50", "100", "2025-12-20", { assetId: "asset_b" })],
        },
      ],
      valuationDate: "2026-01-15",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    // La clase mide lo que su serie sostiene: el +10% del holding con historia.
    expect(equity.twr.reason).toBeNull();
    expect(equity.twr.rate).toBeCloseTo(0.1, 10);
  });

  test("ninguna clase publica un TWR por debajo de −100%", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ commodity: "1" }),
          marketValueMinor: 99_900,
          monthlyCloses: [
            { date: "2025-11-28", valueMinor: 1_010_700 },
            { date: "2025-12-10", valueMinor: 99_900 },
          ],
          operations: [buy("1", "10107", "2025-10-01"), buy("1", "6127", "2025-12-05")],
        },
      ],
      valuationDate: "2026-01-15",
    });

    for (const entry of result.classes) {
      expect(entry.twr.rate === null || entry.twr.rate > -1).toBe(true);
    }
  });
});

describe("una clase sin valor hoy se declara cerrada (#1456)", () => {
  test("la clase liquidada sale marcada y la viva no", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 12_446_600,
          monthlyCloses: [],
          operations: [buy("1000", "1000", "2023-01-01")],
        },
        {
          // Un ETN de bitcoin comprado y vendido en ocho días: cero unidades desde
          // entonces, pero la clase existe porque un día tuvo valor.
          assetClass: classified({ crypto: "1" }),
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [
            buy("1", "58.36", "2026-02-05", { assetId: "asset_etn" }),
            sell("1", "54.00", "2026-02-13", { assetId: "asset_etn" }),
          ],
        },
      ],
      valuationDate: "2026-08-21",
    });

    const equity = result.classes.find((c) => c.key === "equity")!;
    const crypto = result.classes.find((c) => c.key === "crypto")!;
    expect(equity.closed).toBe(false);
    expect(crypto.closed).toBe(true);
    // Sigue emitida con sus medidas: el dominio marca, no omite — quien la lee
    // decide si la enseña (#1456).
    expect(crypto.value.amountMinor).toBe(0);
    expect(crypto.simpleGain.totalGain.amountMinor).toBeLessThan(0);
  });

  test("una clase en pérdidas pero con valor NO está cerrada", () => {
    // La marca separa «no tiene nada» de «va mal»: perder dinero no saca a una
    // clase del reparto de hoy, tener cero sí.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ commodity: "1" }),
          marketValueMinor: 40_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2023-01-01")],
        },
      ],
      valuationDate: "2026-08-21",
    });

    const commodity = result.classes[0]!;
    expect(commodity.closed).toBe(false);
    expect(commodity.simpleGain.totalReturnRatio).toBeLessThan(0);
  });

  test("marcarla no mueve la cobertura del pie", () => {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified({ equity: "1" }),
          marketValueMinor: 100_000,
          monthlyCloses: [],
          operations: [buy("10", "100", "2023-01-01")],
        },
        {
          assetClass: unknown,
          marketValueMinor: 0,
          monthlyCloses: [],
          operations: [
            buy("1", "50", "2026-02-05", { assetId: "asset_x" }),
            sell("1", "40", "2026-02-13", { assetId: "asset_x" }),
          ],
        },
      ],
      valuationDate: "2026-08-21",
    });

    // Una clase a cero no aporta nada a ninguno de los dos lados del reparto.
    expect(result.coverage.classified.amountMinor).toBe(100_000);
    expect(result.coverage.unknown.amountMinor).toBe(0);
    expect(
      result.classes.find((c) => c.key === UNCLASSIFIED_ASSET_CLASS_KEY)!.closed,
    ).toBe(true);
  });
});

describe("un solo reparto de céntimos para exposición y clase (#1610)", () => {
  // Un 60/40 SUCIO: el peso no cae en puntos básicos exactos (0,60005 → 6000,5
  // bps) y el importe no cae en céntimos exactos sobre él. Es el par que hacía
  // diferir a las dos superficies: la exposición repartía por resto mayor sobre
  // el peso exacto y la clase multiplicaba por un peso redondeado a bps.
  const DIRTY_BREAKDOWN = { bond: "0.39995", equity: "0.60005" };
  const HOLDING_VALUE_MINOR = 100_001;
  const CATALOG_KEY = "MIXTO6040";

  function exposureByAssetClass(): Record<string, number> {
    const profile: ExposureProfile = {
      breakdowns: { assetClass: DIRTY_BREAKDOWN },
      declaredAt: null,
      key: CATALOG_KEY,
      source: "user",
    };
    const result = lookThroughExposure({
      baseCurrency: "EUR",
      dimensions: ["assetClass"],
      grossAssets: { amountMinor: HOLDING_VALUE_MINOR, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_mixto",
          instrument: "fund",
          providerSymbol: CATALOG_KEY,
          valueMinor: HOLDING_VALUE_MINOR,
        },
      ],
      profiles: new Map([[CATALOG_KEY, profile]]),
    });

    return Object.fromEntries(
      result.assetClass.slices.map((slice) => [slice.key, slice.value.amountMinor]),
    );
  }

  function returnsValueByClass(): Record<string, number> {
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified(DIRTY_BREAKDOWN),
          marketValueMinor: HOLDING_VALUE_MINOR,
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    return Object.fromEntries(
      result.classes.map((entry) => [entry.key, entry.value.amountMinor]),
    );
  }

  test("las dos superficies reparten el mismo holding en los mismos céntimos", () => {
    expect(returnsValueByClass()).toEqual(exposureByAssetClass());
  });

  test("y ese reparto es el exacto: suma el holding entero, sin sobras", () => {
    const byClass = returnsValueByClass();

    // 100.001 × 0,60005 = 60.005,60005 y × 0,39995 = 39.995,39995: los dos
    // truncan y el céntimo suelto va al resto mayor (renta variable).
    expect(byClass).toEqual({ bond: 39_995, equity: 60_006 });
    // El redondeo a bps daba 60.010 + 40.000 = 100.010: un céntimo de diferencia
    // por clase Y nueve céntimos inventados sobre el holding.
    expect(byClass.equity! + byClass.bond!).toBe(HOLDING_VALUE_MINOR);
  });

  test("un remanente no declarado cuadra en `other` a céntimo en las dos", () => {
    // El mismo careo con el cubo que la exposición inyecta: si una superficie
    // inventase su propio `other`, ningún redondeo lo arreglaría.
    const breakdown = { equity: "0.33335" };
    const valueMinor = 99_999;
    const profile: ExposureProfile = {
      breakdowns: { assetClass: breakdown },
      declaredAt: null,
      key: CATALOG_KEY,
      source: "user",
    };
    const exposure = lookThroughExposure({
      baseCurrency: "EUR",
      dimensions: ["assetClass"],
      grossAssets: { amountMinor: valueMinor, currency: "EUR" },
      holdings: [
        {
          currency: "EUR",
          id: "asset_mixto",
          instrument: "fund",
          providerSymbol: CATALOG_KEY,
          valueMinor,
        },
      ],
      profiles: new Map([[CATALOG_KEY, profile]]),
    });
    const classes = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified(breakdown),
          marketValueMinor: valueMinor,
          monthlyCloses: [],
          operations: [buy("10", "100", "2024-01-01")],
        },
      ],
      valuationDate: "2024-06-01",
    });

    const expected = Object.fromEntries(
      exposure.assetClass.slices.map((slice) => [slice.key, slice.value.amountMinor]),
    );
    expect(
      Object.fromEntries(
        classes.classes.map((entry) => [entry.key, entry.value.amountMinor]),
      ),
    ).toEqual(expected);
    expect(expected.equity! + expected.other!).toBe(valueMinor);
  });

  test("el peso sucio escala también el libro, sin volver a puntos básicos", () => {
    // AC: `subsetReturns` corre sobre esas mismas rebanadas. Lo invertido de la
    // clase sale del peso EXACTO, no de su versión redondeada a bps.
    const result = returnsByAssetClass({
      currency: "EUR",
      holdings: [
        {
          assetClass: classified(DIRTY_BREAKDOWN),
          marketValueMinor: HOLDING_VALUE_MINOR,
          monthlyCloses: [],
          operations: [buy("1", "1000", "2024-01-01")], // 100.000 invertidos
        },
      ],
      valuationDate: "2024-06-01",
    });

    // 100.000 × 0,60005 = 60.005 (con 6.001 bps habrían sido 60.010).
    expect(
      result.classes.find((entry) => entry.key === "equity")!.simpleGain
        .totalInvestedMinor,
    ).toBe(60_005);
    expect(
      result.classes.find((entry) => entry.key === "bond")!.simpleGain.totalInvestedMinor,
    ).toBe(39_995);
  });
});
