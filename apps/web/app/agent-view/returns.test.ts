import type { AgentViewReadStore } from "@worthline/db";
import type {
  AssetClassResolution,
  DatedPayout,
  InvestmentOperation,
  MonthlyCloseValue,
} from "@worthline/domain";
import { subsetReturns } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { buildPortfolioReturns } from "./returns";

/**
 * Regression test for the per-asset-class block on the agent-view path (#552):
 * for a CO-OWNED market holding, the class-level simple gain / IRR must be on the
 * SAME ownership-scoped basis as the portfolio block — i.e. the operation
 * cashflows are scaled by `totalShareBps` before the class weight, so they pair
 * with the scoped `currentValueMinor` (ownedMinor). Without the scaling the class
 * combined gross cost with a scoped value and fabricated a large loss.
 *
 * The second block below (#1593) pins the portfolio measures themselves against
 * `subsetReturns`: the agent view cannot answer the hero's question with another
 * engine (#1422).
 */

function op(
  assetId: string,
  kind: InvestmentOperation["kind"],
  units: string,
  price: string,
  at: string,
  extra: Partial<InvestmentOperation> = {},
): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt: at,
    feesMinor: 0,
    id: `op_${assetId}_${kind}_${at}`,
    kind,
    pricePerUnit: price,
    units,
    ...extra,
  };
}

function buy(
  assetId: string,
  units: string,
  price: string,
  at: string,
): InvestmentOperation {
  return op(assetId, "buy", units, price, at);
}

const equityClass: AssetClassResolution = {
  breakdown: { equity: "1" },
  kind: "classified",
};

/**
 * A read-only fake exposing only the ONE read the block still makes: the frozen
 * holding rows the monthly closes come from. `readOperations` throws on purpose —
 * the ledger arrives from the caller, and a per-holding read inside the fold is
 * the defect #1593 closes.
 */
function fakeStore(
  snapshotRows: {
    holdingId: string;
    snapshotId: string;
    dateKey: string;
    valueMinor: number;
  }[] = [],
): AgentViewReadStore {
  return {
    readOperations: async () => {
      throw new Error("el bloque de returns no lee el ledger holding a holding");
    },
    readSnapshotHoldings: async () =>
      snapshotRows.map((row) => ({ ...row, kind: "asset" as const })),
  } as unknown as AgentViewReadStore;
}

/** A frozen asset row, one per (holding, snapshot) — what the closes derive from. */
function closeRow(
  holdingId: string,
  snapshotId: string,
  dateKey: string,
  valueMinor: number,
) {
  return { dateKey, holdingId, snapshotId, valueMinor };
}

function portfolioReturns(input: {
  holdings: {
    id: string;
    currentValueMinor: number;
    totalShareBps?: number;
    assetClass?: AssetClassResolution;
  }[];
  operations: Record<string, InvestmentOperation[]>;
  payouts?: Record<string, DatedPayout[]>;
  snapshotRows?: Parameters<typeof fakeStore>[0];
  valuationDate?: string;
}) {
  return buildPortfolioReturns({
    currency: "EUR",
    holdings: input.holdings.map((holding) => ({
      currentValueMinor: holding.currentValueMinor,
      id: holding.id,
      instrument: "fund" as const,
      totalShareBps: holding.totalShareBps ?? 10_000,
      ...(holding.assetClass ? { assetClass: holding.assetClass } : {}),
    })),
    operationsByHoldingId: new Map(Object.entries(input.operations)),
    payoutFlowsByHolding: new Map(Object.entries(input.payouts ?? {})),
    scopeId: "household",
    store: fakeStore(input.snapshotRows),
    valuationDate: input.valuationDate ?? "2024-06-01",
  });
}

describe("buildPortfolioReturns byAssetClass", () => {
  test("scales a co-owned holding's operations to its share, matching the scoped value", async () => {
    // Gross: bought 10 units @100 = 100_000 invested; now worth 100_000 gross.
    // 50% owned → scoped value 50_000. The equity class must read break-even, not
    // 100_000 invested against 50_000 value.
    const returns = await portfolioReturns({
      holdings: [
        {
          assetClass: equityClass,
          currentValueMinor: 50_000, // scoped ownedMinor
          id: "h1",
          totalShareBps: 5_000,
        },
      ],
      operations: { h1: [buy("h1", "10", "100", "2024-01-01")] },
    });

    expect(returns).not.toBeNull();
    const equity = returns!.byAssetClass?.classes.find((c) => c.key === "equity");
    expect(equity).toBeDefined();
    expect(equity!.simple.totalInvested).toEqual({
      amountMinor: 50_000,
      currency: "EUR",
    });
    expect(equity!.simple.totalGain).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(equity!.simple.totalReturnRatio).toBe("0");
    // byAssetClass value reconciles with the scoped portfolio value.
    expect(equity!.value).toEqual({ amountMinor: 50_000, currency: "EUR" });
    expect(returns!.byAssetClass?.coverage.classified.amountMinor).toBe(50_000);
  });

  test("omits byAssetClass when no holding carries a resolved class", async () => {
    const returns = await portfolioReturns({
      holdings: [{ currentValueMinor: 50_000, id: "h1" }],
      operations: { h1: [buy("h1", "10", "100", "2024-01-01")] },
    });

    expect(returns).not.toBeNull();
    expect(returns!.byAssetClass).toBeUndefined();
  });

  test("marca la clase que ya no se tiene y calla el marcador en la viva (#1456)", async () => {
    const returns = await portfolioReturns({
      holdings: [
        { assetClass: equityClass, currentValueMinor: 12_446_600, id: "h1" },
        {
          assetClass: { breakdown: { crypto: "1" }, kind: "classified" },
          currentValueMinor: 0,
          id: "h2",
        },
      ],
      operations: {
        h1: [buy("h1", "1000", "1000", "2023-01-01")],
        h2: [buy("h2", "1", "58.36", "2026-02-05")],
      },
      valuationDate: "2026-08-21",
    });

    const classes = returns!.byAssetClass!.classes;
    expect(classes.find((c) => c.key === "crypto")?.closed).toBe(true);
    expect(classes.find((c) => c.key === "equity")).not.toHaveProperty("closed");
  });

  test("la clase sin producto suyo llega marcada y sin ninguna tasa (#1458)", async () => {
    // Un plan mixto 87/13 y un fondo puro: el efectivo del patrimonio existe solo
    // como manga dentro del plan, así que su rentabilidad es la del plan.
    const returns = await portfolioReturns({
      holdings: [
        {
          assetClass: { breakdown: { cash: "0.13", equity: "0.87" }, kind: "classified" },
          currentValueMinor: 40_000,
          id: "plan",
        },
        { assetClass: equityClass, currentValueMinor: 100_000, id: "fondo" },
      ],
      operations: {
        fondo: [buy("fondo", "10", "80", "2023-01-01")],
        plan: [buy("plan", "10", "30", "2023-01-01")],
      },
      valuationDate: "2024-06-01",
    });

    const classes = returns!.byAssetClass!.classes;
    const cash = classes.find((c) => c.key === "cash")!;
    expect(cash.attributedOnly).toBe(true);
    // La cifra prestada no llega al asistente: no se le pide en prosa que no la
    // repita, simplemente no la tiene (ADR 0067).
    expect(cash.moneyWeighted.rate).toBeNull();
    expect(cash.timeWeighted.rate).toBeNull();
    expect(cash.simple.totalReturnRatio).toBeNull();
    expect(cash.simple.cagr).toBeNull();
    expect(cash.value.amountMinor).toBeGreaterThan(0);
    // Renta variable presta parte, pero tiene 100.000 € propios que sí midió.
    const equity = classes.find((c) => c.key === "equity")!;
    expect(equity).not.toHaveProperty("attributedOnly");
    expect(equity.simple.totalReturnRatio).not.toBeNull();
  });
});

/**
 * The portfolio block rides `subsetReturns` (#1593): the same engine the hero
 * (#1592), the cartera gestionada (#1552) and the per-class decomposition ride.
 * These tests fix the four rules the old fold got wrong.
 */
describe("buildPortfolioReturns mide con subsetReturns (#1593)", () => {
  test("un par de traspaso interno no infla el invertido", async () => {
    // 1.000 € comprados en h1; un año después se traspasa entero a h2, ya valiendo
    // 1.100 €. El capital que el libro recibió de fuera sigue siendo 1.000 €.
    const returns = await portfolioReturns({
      holdings: [
        { currentValueMinor: 0, id: "h1" },
        { currentValueMinor: 120_000, id: "h2" },
      ],
      operations: {
        h1: [
          buy("h1", "10", "100", "2023-01-01"),
          op("h1", "transfer_out", "10", "110", "2024-01-01", { transferId: "trf_1" }),
        ],
        h2: [op("h2", "transfer_in", "10", "110", "2024-01-01", { transferId: "trf_1" })],
      },
    });

    expect(returns!.simple.totalInvested).toEqual({
      amountMinor: 100_000,
      currency: "EUR",
    });
    expect(returns!.simple.totalGain).toEqual({ amountMinor: 20_000, currency: "EUR" });
  });

  test("una media mitad cuya contraparte vive fuera sigue siendo capital que entra", async () => {
    // Solo el destino está en el libro medido: el dinero llegó de fuera, así que
    // es capital real y no se cancela contra nada.
    const returns = await portfolioReturns({
      holdings: [{ currentValueMinor: 120_000, id: "h2" }],
      operations: {
        h2: [op("h2", "transfer_in", "10", "110", "2024-01-01", { transferId: "trf_1" })],
      },
    });

    expect(returns!.simple.totalInvested).toEqual({
      amountMinor: 110_000,
      currency: "EUR",
    });
  });

  test("los cobros registrados entran en la ganancia simple y en el IRR", async () => {
    const withoutPayouts = await portfolioReturns({
      holdings: [{ currentValueMinor: 100_000, id: "h1" }],
      operations: { h1: [buy("h1", "10", "100", "2023-01-01")] },
    });
    const withPayouts = await portfolioReturns({
      holdings: [{ currentValueMinor: 100_000, id: "h1" }],
      operations: { h1: [buy("h1", "10", "100", "2023-01-01")] },
      payouts: { h1: [{ amountMinor: 3_000, date: "2023-07-01" }] },
    });

    expect(withoutPayouts!.simple.totalGain.amountMinor).toBe(0);
    expect(withPayouts!.simple.totalGain.amountMinor).toBe(3_000);
    expect(Number(withPayouts!.moneyWeighted.rate)).toBeGreaterThan(0);
    // El cobro escala con la propiedad igual que un flujo de operación.
    const halfOwned = await portfolioReturns({
      holdings: [{ currentValueMinor: 50_000, id: "h1", totalShareBps: 5_000 }],
      operations: { h1: [buy("h1", "10", "100", "2023-01-01")] },
      payouts: { h1: [{ amountMinor: 3_000, date: "2023-07-01" }] },
    });
    expect(halfOwned!.simple.totalGain.amountMinor).toBe(1_500);
  });

  test("declara que la TWR no lleva los cobros, y solo cuando los hay", async () => {
    const withoutPayouts = await portfolioReturns({
      holdings: [{ currentValueMinor: 100_000, id: "h1" }],
      operations: { h1: [buy("h1", "10", "100", "2023-01-01")] },
    });
    const withPayouts = await portfolioReturns({
      holdings: [{ currentValueMinor: 100_000, id: "h1" }],
      operations: { h1: [buy("h1", "10", "100", "2023-01-01")] },
      payouts: { h1: [{ amountMinor: 3_000, date: "2023-07-01" }] },
    });

    const codes = (returns: NonNullable<typeof withoutPayouts>) =>
      returns.qualitySignals.map((signal) => signal.code);

    expect(codes(withoutPayouts!)).toContain("DISTRIBUTIONS_NOT_CAPTURED");
    expect(codes(withPayouts!)).toContain("DISTRIBUTIONS_NOT_IN_TWR");
    expect(codes(withPayouts!)).not.toContain("DISTRIBUTIONS_NOT_CAPTURED");
  });

  test("los cierres del TWR se alinean por mes, no por id de snapshot", async () => {
    // Dos holdings cuyos cierres caen en días distintos del mismo mes. Sumar por
    // id de snapshot deja fuera al que no cerró el día elegido: el diente de
    // sierra de #1457. Alineados por mes, enero vale 150.000 y febrero 170.000.
    const returns = await portfolioReturns({
      holdings: [
        { currentValueMinor: 110_000, id: "h1" },
        { currentValueMinor: 60_000, id: "h2" },
      ],
      operations: {
        h1: [buy("h1", "10", "100", "2023-12-01")],
        h2: [buy("h2", "5", "100", "2023-12-01")],
      },
      snapshotRows: [
        closeRow("h1", "snap_a", "2024-01-31", 100_000),
        closeRow("h2", "snap_c", "2024-01-30", 50_000),
        closeRow("h1", "snap_b", "2024-02-29", 110_000),
        closeRow("h2", "snap_d", "2024-02-28", 60_000),
      ],
      valuationDate: "2024-03-01",
    });

    expect(returns!.timeWeighted.startDate).toBe("2024-01-31");
    expect(returns!.timeWeighted.endDate).toBe("2024-02-29");
    // (170.000 − 150.000) / 150.000, no la lectura por snapshot (10 %).
    expect(Number(returns!.timeWeighted.rate)).toBeCloseTo(20_000 / 150_000, 10);
  });

  test("el bloque es, cifra a cifra, lo que subsetReturns mide sobre el mismo libro", async () => {
    const operations = {
      h1: [
        buy("h1", "10", "100", "2023-01-01"),
        op("h1", "transfer_out", "10", "110", "2024-01-01", { transferId: "trf_1" }),
      ],
      h2: [
        op("h2", "transfer_in", "10", "110", "2024-01-01", { transferId: "trf_1" }),
        buy("h2", "2", "120", "2024-02-01"),
      ],
    };
    const payouts = { h2: [{ amountMinor: 1_200, date: "2024-03-15" }] };
    const snapshotRows = [
      closeRow("h1", "snap_a", "2023-12-31", 105_000),
      closeRow("h2", "snap_b", "2024-01-31", 110_000),
      closeRow("h2", "snap_c", "2024-02-29", 134_000),
      closeRow("h2", "snap_d", "2024-03-31", 140_000),
    ];
    const closes = (holdingId: string): MonthlyCloseValue[] =>
      snapshotRows
        .filter((row) => row.holdingId === holdingId)
        .map((row) => ({ date: row.dateKey, valueMinor: row.valueMinor }));

    const returns = await portfolioReturns({
      holdings: [
        { currentValueMinor: 0, id: "h1" },
        { currentValueMinor: 145_000, id: "h2" },
      ],
      operations,
      payouts,
      snapshotRows,
      valuationDate: "2024-04-01",
    });

    const expected = subsetReturns({
      currency: "EUR",
      slices: [
        {
          marketValueMinor: 0,
          monthlyCloses: closes("h1"),
          operations: operations.h1,
          ownershipBps: 10_000,
        },
        {
          marketValueMinor: 145_000,
          monthlyCloses: closes("h2"),
          operations: operations.h2,
          ownershipBps: 10_000,
          payouts: payouts.h2,
        },
      ],
      valuationDate: "2024-04-01",
    });

    // Guardrail: a careo against two nulls would pass while measuring nothing.
    expect(expected.irr.rate).not.toBeNull();
    expect(expected.twr.rate).not.toBeNull();
    // El par de traspaso se anula: 1.000 € en h1 + 240 € en h2, no las dos mitades.
    expect(expected.simpleGain.totalInvestedMinor).toBe(124_000);

    expect(returns!.simple.totalInvested.amountMinor).toBe(
      expected.simpleGain.totalInvestedMinor,
    );
    expect(returns!.simple.totalGain.amountMinor).toBe(
      expected.simpleGain.totalGain.amountMinor,
    );
    expect(returns!.simple.totalReturnRatio).toBe(
      expected.simpleGain.totalReturnRatio?.toString() ?? null,
    );
    // El tramo (y con él el CAGR) sale del propio motor: arranca en el primer FLUJO,
    // así que el residual nulo de un traspaso interno no lo adelanta.
    expect(returns!.simple.annualized).toBe(expected.simpleGain.annualized);
    expect(returns!.simple.cagr).toBe(expected.simpleGain.cagr?.toString() ?? null);
    expect(returns!.moneyWeighted.rate).toBe(expected.irr.rate?.toString() ?? null);
    expect(returns!.timeWeighted.rate).toBe(expected.twr.rate?.toString() ?? null);
    expect(returns!.timeWeighted.startDate).toBe(expected.twr.startDate);
    expect(returns!.timeWeighted.endDate).toBe(expected.twr.endDate);
  });

  test("un libro sin holdings de mercado con ledger no fabrica un retorno", async () => {
    const returns = await portfolioReturns({
      holdings: [{ currentValueMinor: 100_000, id: "h1" }],
      operations: {},
    });

    expect(returns).toBeNull();
  });
});
