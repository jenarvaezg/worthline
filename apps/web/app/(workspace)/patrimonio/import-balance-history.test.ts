import { describe, expect, test } from "vitest";

import {
  BALANCE_HISTORY_MESSAGES,
  type BalanceHistoryDebtContext,
  composeBalanceHistoryRebaselines,
  parseBalanceHistoryRows,
  planBalanceHistoryImport,
  previewBalanceHistoryImport,
} from "./import-balance-history";

const TODAY = "2026-07-02";

const PLAN_CTX: BalanceHistoryDebtContext = {
  balanceRebaselines: [],
  currentBalanceMinor: 150_000_00,
  earlyRepayments: [],
  plan: {
    annualInterestRate: "0.03",
    disbursementDate: "2026-01-15",
    firstPaymentDate: "2026-02-15",
    initialCapitalMinor: 150_000_00,
    termMonths: 240,
  },
  revisions: [],
  today: TODAY,
};

/**
 * Una deuda lo bastante vieja para que un cuadro fechado en 2020 caiga DENTRO de su
 * vida: con `PLAN_CTX` toda fila de 2020 sería pre-origen y la prueba mediría esa
 * exclusión en vez del plegado de fechas repetidas (#1429).
 */
const SCHEDULE_CTX: BalanceHistoryDebtContext = {
  ...PLAN_CTX,
  plan: {
    annualInterestRate: "0.03",
    disbursementDate: "2015-01-15",
    firstPaymentDate: "2015-02-15",
    initialCapitalMinor: 150_000_00,
    termMonths: 360,
  },
};

describe("previewBalanceHistoryImport — per-row validation and drift (#696)", () => {
  test("accepts valid rows with drift computed vs the curve", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      PLAN_CTX,
    );
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({
      date: "2026-06-15",
      driftMinor: expect.any(Number),
      status: "accepted",
    });
    expect(preview[0]!.driftMinor).not.toBe(0);
  });

  test("excludes non-positive balance with Spanish reason", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 0, date: "2026-06-15" }],
      PLAN_CTX,
    );
    expect(preview[0]).toEqual({
      balanceMinor: 0,
      date: "2026-06-15",
      driftMinor: null,
      reason: BALANCE_HISTORY_MESSAGES.nonPositiveBalance,
      status: "excluded",
    });
  });

  test("excludes future dates", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 100_000_00, date: "2026-07-03" }],
      PLAN_CTX,
    );
    expect(preview[0]?.reason).toBe(BALANCE_HISTORY_MESSAGES.futureDate);
    expect(preview[0]?.status).toBe("excluded");
  });

  test("excludes pre-origin dates", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 100_000_00, date: "2026-01-01" }],
      PLAN_CTX,
    );
    expect(preview[0]?.status).toBe("excluded");
    expect(preview[0]?.reason).toBe(BALANCE_HISTORY_MESSAGES.preOrigin);
  });

  test("skips idempotent rows that already exist with the same balance", () => {
    const ctx: BalanceHistoryDebtContext = {
      ...PLAN_CTX,
      balanceRebaselines: [
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-06-15",
          endDate: "2046-01-15",
          nextPaymentDate: "2026-07-15",
          outstandingBalanceMinor: 140_000_00,
          startsAtBaseline: false,
        },
      ],
    };
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      ctx,
    );
    expect(preview[0]?.status).toBe("skipped");
    expect(preview[0]?.driftMinor).toBe(0);
  });

  test("excludes duplicate dates with a different balance", () => {
    const ctx: BalanceHistoryDebtContext = {
      ...PLAN_CTX,
      balanceRebaselines: [
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-06-15",
          endDate: "2046-01-15",
          nextPaymentDate: "2026-07-15",
          outstandingBalanceMinor: 140_000_00,
          startsAtBaseline: false,
        },
      ],
    };
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 138_000_00, date: "2026-06-15" }],
      ctx,
    );
    expect(preview[0]?.status).toBe("excluded");
    expect(preview[0]?.reason).toBe(BALANCE_HISTORY_MESSAGES.duplicateDate);
  });

  test("una amortización anticipada mueve la curva contra la que se mide el desvío (#1422)", () => {
    // Sin ella, esta curva y la que el store calcula para la MISMA deuda eran dos
    // motores distintos, y el extremo proyectado se comparaba con un saldo ajeno.
    const withRepayment = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      {
        ...PLAN_CTX,
        earlyRepayments: [
          { amountMinor: 10_000_00, mode: "reduce-term", repaymentDate: "2026-03-15" },
        ],
      },
    );
    const without = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      PLAN_CTX,
    );
    expect(withRepayment[0]!.driftMinor).not.toBe(without[0]!.driftMinor);
  });

  test("la fila que cierra el día decide solo si ella misma es usable (#1422)", () => {
    // El «0,00 €» con el que acaba un cuadro de amortización, repetido en la fecha
    // de una observación buena, no puede llevársela por delante.
    const plan = planBalanceHistoryImport(
      [
        { balanceMinor: 139_000_00, date: "2026-06-15" },
        { balanceMinor: 0, date: "2026-06-15" },
      ],
      PLAN_CTX,
    );
    expect(plan.composed).toHaveLength(1);
    expect(plan.composed[0]?.outstandingBalanceMinor).toBe(139_000_00);
  });

  test("dos saldos el mismo día: manda el último del documento (#1422)", () => {
    // Las dos amortizaciones anticipadas de Jorge el 2004-06-01: el saldo que
    // cierra el día es el segundo, no el primero.
    const preview = previewBalanceHistoryImport(
      [
        { balanceMinor: 140_000_00, date: "2026-06-15" },
        { balanceMinor: 139_000_00, date: "2026-06-15" },
      ],
      PLAN_CTX,
    );
    expect(preview.find((row) => row.status === "accepted")?.balanceMinor).toBe(
      139_000_00,
    );
    const folded = preview.find(
      (row) => row.reason === BALANCE_HISTORY_MESSAGES.duplicateInBatch,
    );
    expect(folded?.status).toBe("excluded");
    expect(folded?.balanceMinor).toBe(140_000_00);
  });

  test("un cuadro de 450 filas sobre 9 días compone 9 re-baselines (#1429)", () => {
    // El cuadro que el test del cuaderno adjuntaba antes de #1422: 450 saldos sobre
    // nueve fechas, cada una repetida cincuenta veces. Lo que se comprueba aquí es
    // que la regla de #1422 —manda la última fila del día— aguanta a escala: la
    // cadena que se persiste tiene UNA re-baseline por día, no una por fila, y las
    // 441 anteriores se pliegan diciendo por qué en vez de encadenarse unas sobre
    // otras. Sin esto, nueve observaciones reales llegarían al store como 450
    // escrituras y un ripple por cada una.
    const DAYS = 9;
    const ROWS_PER_DAY = 50;
    const rows = Array.from({ length: DAYS * ROWS_PER_DAY }, (_unused, index) => ({
      balanceMinor: 100_000_00 - index * 100_00,
      date: `2020-0${(index % DAYS) + 1}-01`,
    }));

    const plan = planBalanceHistoryImport(rows, SCHEDULE_CTX);

    // Ninguna fila se pierde de la tarjeta: las 450 se ven, 441 plegadas.
    expect(plan.previews).toHaveLength(rows.length);
    const accepted = plan.previews.filter((row) => row.status === "accepted");
    expect(accepted).toHaveLength(DAYS);
    expect(
      plan.previews.filter(
        (row) => row.reason === BALANCE_HISTORY_MESSAGES.duplicateInBatch,
      ),
    ).toHaveLength(rows.length - DAYS);
    expect(accepted.map((row) => row.date)).toEqual([
      "2020-01-01",
      "2020-02-01",
      "2020-03-01",
      "2020-04-01",
      "2020-05-01",
      "2020-06-01",
      "2020-07-01",
      "2020-08-01",
      "2020-09-01",
    ]);
    // Y la que manda es la última del documento en su día: para el 1 de enero, la
    // fila 442 (la 50ª de ese día) y no la 1 — así que la curva compuesta arranca
    // en los 55.900 con los que el cuadro casi acaba, no en los 100.000 con los que
    // abre. Las dos cifras son las últimas nueve filas del documento.
    expect(accepted.map((row) => row.balanceMinor)).toEqual(
      rows.slice(-DAYS).map((row) => row.balanceMinor),
    );
    expect(plan.composed).toHaveLength(DAYS);
    expect(plan.composed.map((item) => item.baselineDate)).toEqual(
      accepted.map((row) => row.date),
    );
  });

  test("chains composition: the second row composes off the first accepted row", () => {
    const plan = planBalanceHistoryImport(
      [
        { balanceMinor: 145_000_00, date: "2026-04-15" },
        { balanceMinor: 140_000_00, date: "2026-06-15" },
      ],
      PLAN_CTX,
    );
    expect(plan.previews.filter((row) => row.status === "accepted")).toHaveLength(2);
    expect(plan.composed).toHaveLength(2);
    expect(plan.composed[0]?.baselineDate).toBe("2026-04-15");
    expect(plan.composed[1]?.baselineDate).toBe("2026-06-15");
    expect(plan.composed[1]?.endDate).toBe(plan.composed[0]?.endDate);
  });

  test("drift is computed vs the vigente curve, not prior batch rows", () => {
    const single = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      PLAN_CTX,
    )[0]!;
    const batch = planBalanceHistoryImport(
      [
        { balanceMinor: 145_000_00, date: "2026-04-15" },
        { balanceMinor: 140_000_00, date: "2026-06-15" },
      ],
      PLAN_CTX,
    );
    const secondInBatch = batch.previews.find((row) => row.date === "2026-06-15")!;
    expect(secondInBatch.driftMinor).toBe(single.driftMinor);
  });
});

describe("composeBalanceHistoryRebaselines", () => {
  test("returns only accepted rows in date order", () => {
    const preview = previewBalanceHistoryImport(
      [
        { balanceMinor: 0, date: "2026-05-15" },
        { balanceMinor: 145_000_00, date: "2026-04-15" },
      ],
      PLAN_CTX,
    );
    const composed = composeBalanceHistoryRebaselines(preview, PLAN_CTX);
    expect(composed).toHaveLength(1);
    expect(composed[0]?.baselineDate).toBe("2026-04-15");
  });

  test("honours an optional annual rate override per row", () => {
    const preview = previewBalanceHistoryImport(
      [{ annualRate: "0.025", balanceMinor: 140_000_00, date: "2026-06-15" }],
      PLAN_CTX,
    );
    const composed = composeBalanceHistoryRebaselines(preview, PLAN_CTX);
    expect(composed[0]?.annualInterestRate).toBe("0.025");
  });
});

describe("parseBalanceHistoryRows", () => {
  test("rejects non-integer balanceMinor values", () => {
    const result = parseBalanceHistoryRows([
      { balanceMinor: "140000", date: "2026-06-15" },
    ]);
    expect(result).toEqual({
      error: BALANCE_HISTORY_MESSAGES.invalidSeries,
      ok: false,
    });
  });

  test("a schedule that ends on 0 parses, and only that row is excluded (#1417)", () => {
    const result = parseBalanceHistoryRows([
      { balanceMinor: 140_000_00, date: "2026-06-15" },
      { balanceMinor: 0, date: "2026-06-20" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const preview = previewBalanceHistoryImport(result.rows, PLAN_CTX);
    expect(preview.map((row) => row.status)).toEqual(["accepted", "excluded"]);
    expect(preview[1]?.reason).toBe(BALANCE_HISTORY_MESSAGES.nonPositiveBalance);
  });

  test("accepts a well-formed series", () => {
    const result = parseBalanceHistoryRows([
      { annualRate: "0.03", balanceMinor: 140_000_00, date: "2026-06-15" },
    ]);
    expect(result).toEqual({
      ok: true,
      rows: [{ annualRate: "0.03", balanceMinor: 140_000_00, date: "2026-06-15" }],
    });
  });
});
