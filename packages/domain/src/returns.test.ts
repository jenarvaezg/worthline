import { describe, expect, test } from "vitest";

import type { InvestmentOperation, OperationKind } from "./index";
import {
  holdingIrr,
  holdingTwr,
  monthlyCloseValuesByHolding,
  monthlyCloseValuesFromSnapshotRows,
  operationCashflows,
  operationTwrCashflows,
  simpleGain,
  timeWeightedReturn,
  xirr,
} from "./returns";

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
  extra?: Partial<InvestmentOperation>,
) => op("buy", units, price, at, extra);
const sell = (
  units: string,
  price: string,
  at: string,
  extra?: Partial<InvestmentOperation>,
) => op("sell", units, price, at, extra);

describe("operationCashflows", () => {
  test("buy is a negative outflow (net of fees), sell a positive inflow", () => {
    const flows = operationCashflows([
      buy("10", "100", "2026-01-01", { feesMinor: 500 }),
      sell("4", "150", "2026-02-01", { feesMinor: 200 }),
    ]);

    expect(flows).toEqual([
      { amountMinor: -100_500, date: "2026-01-01" }, // −(1000.00 + 5.00 fee)
      { amountMinor: 59_800, date: "2026-02-01" }, // 600.00 − 2.00 fee
    ]);
  });
});

describe("xirr", () => {
  test("a single buy held exactly 3 years to a known value matches (value/cost)^(1/N)−1", () => {
    // 2021-01-01 → 2024-01-01 is 365 × 3 = 1095 days (2021/22/23 are all 365d).
    const result = xirr([
      { amountMinor: -10_000, date: "2021-01-01" },
      { amountMinor: 13_310, date: "2024-01-01" },
    ]);

    // (13310/10000)^(1/3) − 1 = 1.331^(1/3) − 1 = 0.10
    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(0.1, 6);
  });

  test("multiple irregular contributions match an independently-computed reference", () => {
    // Reference root computed by an independent bisection over the same flows
    // (act/365 day-count): NPV(1.08799297) ≈ 0.
    const result = xirr([
      { amountMinor: -1_000_000, date: "2008-01-01" },
      { amountMinor: 275_000, date: "2008-03-01" },
      { amountMinor: 425_000, date: "2008-10-30" },
      { amountMinor: 325_000, date: "2008-02-15" },
      { amountMinor: 275_000, date: "2008-04-01" },
    ]);

    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(1.08799297, 6);
  });

  test("fewer than two cashflows is insufficient", () => {
    expect(xirr([{ amountMinor: -10_000, date: "2021-01-01" }])).toEqual({
      rate: null,
      reason: "insufficient_cashflows",
    });
  });

  test("cashflows that never change sign have no root", () => {
    const result = xirr([
      { amountMinor: -10_000, date: "2021-01-01" },
      { amountMinor: -5_000, date: "2022-01-01" },
    ]);

    expect(result).toEqual({ rate: null, reason: "single_sign" });
  });

  test("all cashflows on one day span no time", () => {
    const result = xirr([
      { amountMinor: -10_000, date: "2021-01-01" },
      { amountMinor: 11_000, date: "2021-01-01" },
    ]);

    expect(result).toEqual({ rate: null, reason: "zero_time_span" });
  });
});

describe("holdingIrr", () => {
  test("a single buy plus a terminal market value resolves to the same annual rate", () => {
    const result = holdingIrr({
      currency: "EUR",
      marketValueMinor: 13_310,
      operations: [buy("100", "1", "2021-01-01")], // cost 100.00 = 10_000 minor
      valuationDate: "2024-01-01",
    });

    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(0.1, 6);
  });

  test("a fully-sold holding derives IRR from buys and sells alone", () => {
    const result = holdingIrr({
      currency: "EUR",
      marketValueMinor: 0,
      operations: [buy("100", "1", "2021-01-01"), sell("100", "1.331", "2024-01-01")],
      valuationDate: "2024-06-01",
    });

    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(0.1, 6);
  });

  test("a total loss (bought, now worthless) returns null with a reason, never a bogus number", () => {
    const result = holdingIrr({
      currency: "EUR",
      marketValueMinor: 0,
      operations: [buy("100", "1", "2021-01-01"), buy("50", "1", "2022-01-01")],
      valuationDate: "2024-01-01",
    });

    expect(result.rate).toBeNull();
    expect(result.reason).toBe("single_sign");
  });
});

describe("timeWeightedReturn", () => {
  test("no cashflows equals the chained price-driven change between monthly closes", () => {
    const result = timeWeightedReturn({
      cashflows: [],
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000 },
        { date: "2024-02-29", valueMinor: 110_000 },
        { date: "2024-03-31", valueMinor: 121_000 },
      ],
    });

    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(0.21, 10);
    expect(result.startDate).toBe("2024-01-31");
    expect(result.endDate).toBe("2024-03-31");
    expect(result.spanDays).toBe(60);
    expect(result.annualized).toBe(false);
    expect(result.annualizedRate).toBeNull();
  });

  test("mid-month contributions are weighted by the fraction of the month remaining", () => {
    const result = timeWeightedReturn({
      cashflows: [{ amountMinor: 20_000, date: "2024-02-15" }],
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000 },
        { date: "2024-02-29", valueMinor: 130_000 },
      ],
    });

    const expected = 10_000 / (100_000 + 20_000 * (14 / 29));
    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(expected, 10);
  });

  test("holding TWR diverges from IRR when a large late contribution enters a rising market", () => {
    const operations = [buy("10", "100", "2024-01-31"), buy("10", "100", "2024-03-25")];
    const twr = holdingTwr({
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000 },
        { date: "2024-02-29", valueMinor: 110_000 },
        { date: "2024-03-31", valueMinor: 220_000 },
      ],
      operations,
    });
    const irr = holdingIrr({
      currency: "EUR",
      marketValueMinor: 220_000,
      operations,
      valuationDate: "2024-03-31",
    });

    const marchDietz = 10_000 / (110_000 + 100_000 * (6 / 31));
    expect(twr.reason).toBeNull();
    expect(twr.rate).toBeCloseTo(1.1 * (1 + marchDietz) - 1, 10);
    expect(irr.rate).not.toBeNull();
    expect(twr.rate as number).toBeLessThan(irr.rate as number);
  });

  test("starts at the first monthly close and annualizes only spans of at least one year", () => {
    const result = timeWeightedReturn({
      cashflows: [{ amountMinor: 50_000, date: "2024-01-15" }],
      monthlyCloses: [
        { date: "2024-06-30", valueMinor: 100_000 },
        { date: "2025-06-30", valueMinor: 110_000 },
      ],
    });

    expect(result.reason).toBeNull();
    expect(result.startDate).toBe("2024-06-30");
    expect(result.spanDays).toBe(365);
    expect(result.rate).toBeCloseTo(0.1, 10);
    expect(result.annualized).toBe(true);
    expect(result.annualizedRate).toBeCloseTo(0.1, 10);
  });

  test("a mid-month contribution is weighed by its days in the month", () => {
    const result = timeWeightedReturn({
      cashflows: operationTwrCashflows([
        buy("10", "100", "2024-01-31", { assetId: "asset_a" }),
        buy("5", "100", "2024-02-15", { assetId: "asset_b" }),
      ]),
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000 },
        { date: "2024-02-29", valueMinor: 170_000 },
      ],
    });

    // Modified Dietz weighs February's 500.00 contribution by its 14 days in the month.
    // This is the primitive alone: the same guarantee for a SET of holdings — flows
    // scaled, traspaso halves paired — is `subsetReturns`' in `returns-subset.test.ts`.
    const expected = 20_000 / (100_000 + 50_000 * (14 / 29));
    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(expected, 10);
  });

  test("snapshot rows feed TWR as the last available close in each month", () => {
    expect(
      monthlyCloseValuesFromSnapshotRows([
        { snapshotId: "jan_1", dateKey: "2024-01-15", valueMinor: 90_000 },
        { snapshotId: "jan_2", dateKey: "2024-01-31", valueMinor: 100_000 },
        { snapshotId: "feb_1", dateKey: "2024-02-20", valueMinor: 110_000 },
      ]),
    ).toEqual([
      { date: "2024-01-31", valueMinor: 100_000 },
      { date: "2024-02-20", valueMinor: 110_000 },
    ]);
  });
});

describe("monthlyCloseValuesByHolding (#1586)", () => {
  test("agrupa filas de snapshot en un cierre mensual por holding y mes", () => {
    expect(
      monthlyCloseValuesByHolding([
        {
          holdingId: "a",
          snapshotId: "jan_a1",
          dateKey: "2024-01-15",
          valueMinor: 90_000,
        },
        {
          holdingId: "b",
          snapshotId: "jan_b",
          dateKey: "2024-01-20",
          valueMinor: 50_000,
        },
        {
          holdingId: "a",
          snapshotId: "jan_a2",
          dateKey: "2024-01-31",
          valueMinor: 100_000,
        },
        {
          holdingId: "a",
          snapshotId: "feb_a",
          dateKey: "2024-02-29",
          valueMinor: 110_000,
        },
      ]),
    ).toEqual(
      new Map([
        [
          "a",
          [
            { date: "2024-01-31", valueMinor: 100_000 },
            { date: "2024-02-29", valueMinor: 110_000 },
          ],
        ],
        ["b", [{ date: "2024-01-20", valueMinor: 50_000 }]],
      ]),
    );
  });

  test("omite holdings fuera del conjunto pedido", () => {
    expect(
      monthlyCloseValuesByHolding(
        [
          {
            holdingId: "keep",
            snapshotId: "s1",
            dateKey: "2024-01-31",
            valueMinor: 10_000,
          },
          {
            holdingId: "drop",
            snapshotId: "s1",
            dateKey: "2024-01-31",
            valueMinor: 99_000,
          },
        ],
        new Set(["keep"]),
      ),
    ).toEqual(new Map([["keep", [{ date: "2024-01-31", valueMinor: 10_000 }]]]));
  });
});

describe("una cadena de TWR con el signo roto (#1457)", () => {
  test("un tramo con 1 + R ≤ 0 devuelve TWR no disponible, no un imposible (#1457)", () => {
    // El caso reproducido en el workspace real: materias primas, nov–dic 2025.
    // El flujo del periodo (+6.127 €) es enorme frente al valor de la clase, así
    // que R cae por debajo de −100% y el factor se volvería negativo.
    const result = timeWeightedReturn({
      cashflows: [{ amountMinor: 612_700, date: "2025-12-05" }],
      monthlyCloses: [
        { date: "2025-11-28", valueMinor: 1_010_700 },
        { date: "2025-12-10", valueMinor: 99_900 },
      ],
    });

    expect(result.rate).toBeNull();
    expect(result.annualizedRate).toBeNull();
    expect(result.reason).toBe("non_measurable_subperiod");
    expect(result.startDate).toBe("2025-11-28");
    expect(result.endDate).toBe("2025-12-10");
  });

  test("un tramo no medible corta la cadena aunque el resto sea medible (#1457)", () => {
    const result = timeWeightedReturn({
      cashflows: [{ amountMinor: 1_000_000, date: "2024-02-15" }],
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000 },
        { date: "2024-02-29", valueMinor: 50_000 },
        { date: "2024-03-31", valueMinor: 60_000 },
      ],
    });

    expect(result.rate).toBeNull();
    expect(result.reason).toBe("non_measurable_subperiod");
  });

  test("una pérdida grande pero medible sigue siendo una rentabilidad (#1457)", () => {
    const result = timeWeightedReturn({
      cashflows: [],
      monthlyCloses: [
        { date: "2024-01-31", valueMinor: 100_000 },
        { date: "2024-02-29", valueMinor: 10_000 },
      ],
    });

    expect(result.reason).toBeNull();
    expect(result.rate).toBeCloseTo(-0.9, 10);
    expect(result.rate as number).toBeGreaterThan(-1);
  });
});

describe("simpleGain", () => {
  test("total gain is realized plus unrealized over total invested", () => {
    const gain = simpleGain({
      currency: "EUR",
      marketValueMinor: 90_000, // 6 units left, worth 150.00 each
      operations: [buy("10", "100", "2026-01-01"), sell("4", "150", "2026-06-01")],
      valuationDate: "2026-07-01",
    });

    // invested 1000.00; proceeds 600.00 + market 900.00 − 1000.00 = 500.00 gain
    expect(gain.totalGain).toEqual({ amountMinor: 50_000, currency: "EUR" });
    expect(gain.totalInvestedMinor).toBe(100_000);
    expect(gain.totalReturnRatio).toBeCloseTo(0.5, 10);
  });

  test("a sub-year holding reports total only, not annualized", () => {
    const gain = simpleGain({
      currency: "EUR",
      marketValueMinor: 11_000,
      operations: [buy("100", "1", "2026-01-01")], // 10_000 invested
      valuationDate: "2026-07-01", // ~181 days
    });

    expect(gain.totalReturnRatio).toBeCloseTo(0.1, 10);
    expect(gain.annualized).toBe(false);
    expect(gain.cagr).toBeNull();
  });

  test("a multi-year holding reports a CAGR", () => {
    const gain = simpleGain({
      currency: "EUR",
      marketValueMinor: 13_310,
      operations: [buy("100", "1", "2021-01-01")], // 10_000 invested
      valuationDate: "2024-01-01", // 1095 days = 3 years
    });

    expect(gain.annualized).toBe(true);
    // (1 + 0.331)^(365/1095) − 1 = 1.331^(1/3) − 1 = 0.10
    expect(gain.cagr).toBeCloseTo(0.1, 6);
  });
});

describe("payouts in returns (#657)", () => {
  const flatBuy = buy("100", "100", "2021-01-01"); // −10 000.00, terminal flat

  test("simpleGain: a payout is realized proceeds, not extra invested", () => {
    const withPayout = simpleGain({
      currency: "EUR",
      marketValueMinor: 1_000_000, // flat: value == cost
      operations: [flatBuy],
      payouts: [{ amountMinor: 50_000, date: "2022-01-01" }],
      valuationDate: "2024-01-01",
    });

    // +500.00 of income lands as gain; the invested denominator is unchanged.
    expect(withPayout.totalGain.amountMinor).toBe(50_000);
    expect(withPayout.totalInvestedMinor).toBe(1_000_000);
    expect(withPayout.totalReturnRatio).toBeCloseTo(0.05, 8);
  });

  test("holdingIrr: a payout raises the money-weighted return", () => {
    const input = {
      currency: "EUR" as const,
      marketValueMinor: 1_000_000, // flat
      operations: [flatBuy],
      valuationDate: "2024-01-01",
    };
    const without = holdingIrr(input);
    const withPayout = holdingIrr({
      ...input,
      payouts: [{ amountMinor: 50_000, date: "2022-01-01" }],
    });

    expect(without.rate).toBeCloseTo(0, 6); // flat holding earns nothing
    expect(withPayout.reason).toBeNull();
    expect(withPayout.rate as number).toBeGreaterThan(0);
  });

  test("empty (or omitted) payout series is a no-op", () => {
    const input = {
      currency: "EUR" as const,
      marketValueMinor: 1_300_000,
      operations: [flatBuy],
      valuationDate: "2024-01-01",
    };
    expect(simpleGain({ ...input, payouts: [] })).toEqual(simpleGain(input));
    expect(holdingIrr({ ...input, payouts: [] })).toEqual(holdingIrr(input));
  });

  test("a reinvested dividend (+payout, −buy) nets out by construction", () => {
    // Reinvestment: the fund pays 1 000.00 and it is immediately bought back as
    // 10 units @100 on the same day. Recording both must leave the return
    // identical to never recording either (the fund simply grew its units).
    const reinvested = {
      currency: "EUR" as const,
      marketValueMinor: 1_200_000, // 110 units now worth this
      operations: [flatBuy, buy("10", "100", "2022-01-01")],
      payouts: [{ amountMinor: 100_000, date: "2022-01-01" }],
      valuationDate: "2024-01-01",
    };
    const asIfGrown = {
      currency: "EUR" as const,
      marketValueMinor: 1_200_000,
      operations: [flatBuy],
      valuationDate: "2024-01-01",
    };

    expect(simpleGain(reinvested).totalGain.amountMinor).toBe(
      simpleGain(asIfGrown).totalGain.amountMinor,
    );
    expect(holdingIrr(reinvested).rate as number).toBeCloseTo(
      holdingIrr(asIfGrown).rate as number,
      8,
    );
  });
});

describe("el traspaso en los retornos (#1393)", () => {
  const transferOut = (units: string, price: string, at: string) =>
    op("transfer_out", units, price, at, { transferId: "trf_1" });
  const transferIn = (units: string, price: string, at: string, costMinor: number) =>
    op("transfer_in", units, price, at, {
      transferCostMinor: costMinor,
      transferId: "trf_1",
    });

  test("el par se lee con los signos de venta y compra, a mercado del día", () => {
    expect(operationCashflows([transferOut("5", "150", "2026-02-01")])).toEqual([
      { amountMinor: 75_000, date: "2026-02-01" },
    ]);
    expect(operationCashflows([transferIn("5", "150", "2026-02-01", 50_000)])).toEqual([
      { amountMinor: -75_000, date: "2026-02-01" },
    ]);
  });

  test("el IRR del origen ve la salida: el traspaso es flujo real de la posición", () => {
    const result = holdingIrr({
      currency: "EUR",
      // 1.000 € in, everything out a year later at 1.100 €: a 10 % money-weighted
      // return, whether the exit was a sale or a traspaso.
      marketValueMinor: 0,
      operations: [
        buy("10", "100", "2025-01-01"),
        transferOut("10", "110", "2026-01-01"),
      ],
      valuationDate: "2026-01-01",
    });

    expect(result.reason).toBeNull();
    expect(result.rate as number).toBeCloseTo(0.1, 4);
  });

  test("el IRR del destino arranca en el traspaso, no en una compra inventada", () => {
    const result = holdingIrr({
      currency: "EUR",
      marketValueMinor: 121_000,
      operations: [transferIn("10", "110", "2025-01-01", 100_000)],
      valuationDate: "2026-01-01",
    });

    expect(result.reason).toBeNull();
    expect(result.rate as number).toBeCloseTo(0.1, 4);
  });
});
