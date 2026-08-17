import { describe, expect, test } from "vitest";

import {
  type AmortizationScheduleReading,
  readAmortizationSchedule,
  type ScheduleSheet,
} from "./amortization-schedule-adapter";

/**
 * The fixtures mirror the real Santander workbook behind #1406: a wide matrix of
 * anniversaries above a long table of cuotas, in the same sheet, with Spanish and
 * plain decimals mixed inside one file.
 */
function sheet(rows: string[][], name = ""): ScheduleSheet {
  return { name, rows };
}

function read(rows: string[][], name = ""): AmortizationScheduleReading {
  const result = readAmortizationSchedule([sheet(rows, name)]);
  if (!result.ok) throw new Error(`expected a reading, got: ${result.message}`);
  return result.value;
}

const SANTANDER_MATRIX: string[][] = [
  ["", "01/05/2004", "01/05/2005", "01/05/2006"],
  ["Capital", "173153.18", "160855.24", "155438.99"],
  ["Interés", "0,027", "0,02815", "0,03771"],
  ["Plazo", "360"],
  ["Amortiz Anticipada", "", "1803,04"],
];

describe("readAmortizationSchedule — the wide matrix", () => {
  test("one column per anniversary yields a revision, a balance and a lump", () => {
    const reading = read(SANTANDER_MATRIX);

    expect(reading.revisions).toEqual([
      { annualInterestRate: "0.027", revisionDate: "2004-05-01" },
      { annualInterestRate: "0.02815", revisionDate: "2005-05-01" },
      { annualInterestRate: "0.03771", revisionDate: "2006-05-01" },
    ]);
    expect(reading.declaredBalances).toEqual([
      { balanceMinor: 17_315_318, dateKey: "2004-05-01" },
      { balanceMinor: 16_085_524, dateKey: "2005-05-01" },
      { balanceMinor: 15_543_899, dateKey: "2006-05-01" },
    ]);
    expect(reading.earlyRepayments).toEqual([
      { amountMinor: 180_304, repaymentDate: "2005-05-01" },
    ]);
  });

  test("«Capital» keyed by revision dates IS the outstanding balance", () => {
    // The opposite call from #1417's long-table rule, and both are right: what
    // decides is whether the figures are keyed by anniversary or by cuota.
    const reading = read(SANTANDER_MATRIX);
    expect(reading.declaredBalances[0]?.balanceMinor).toBe(17_315_318);
  });

  test("rates written as percentages are recognized by their magnitude", () => {
    const reading = read([
      ["", "01/05/2004", "01/05/2005"],
      ["Tipo", "2,70", "2,815"],
    ]);
    expect(reading.revisions.map((revision) => revision.annualInterestRate)).toEqual([
      "0.027",
      "0.02815",
    ]);
    expect(reading.rateScaleAmbiguous).toBe(false);
  });

  test("a percent sign settles the scale even when every value is below one", () => {
    const reading = read([
      ["", "01/05/2020", "01/05/2021"],
      ["Tipo", "0,44 %", "0,066 %"],
    ]);
    expect(reading.revisions.map((revision) => revision.annualInterestRate)).toEqual([
      "0.0044",
      "0.00066",
    ]);
    expect(reading.rateScaleAmbiguous).toBe(false);
  });

  test("all-below-one and no percent sign is ambiguous, and says so", () => {
    expect(read(SANTANDER_MATRIX).rateScaleAmbiguous).toBe(true);
  });

  test("a cell too big to be a rate is dropped OUT LOUD, never in silence", () => {
    const reading = read([
      ["", "01/05/2004", "01/05/2005"],
      ["Tipo", "2,70", "163856,72"],
    ]);
    expect(reading.revisions.map((revision) => revision.revisionDate)).toEqual([
      "2004-05-01",
    ]);
    expect(reading.warnings[0]).toContain("2005-05-01");
  });

  test("a dates-across-the-top table with no rate row is not a schedule", () => {
    const result = readAmortizationSchedule([
      sheet([
        ["", "01/05/2004", "01/05/2005"],
        ["Capital", "173153.18", "160855.24"],
      ]),
    ]);
    expect(result.ok).toBe(false);
  });

  test("a single dated column is not a matrix", () => {
    const result = readAmortizationSchedule([
      sheet([
        ["", "01/05/2004"],
        ["Interés", "0,027"],
      ]),
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("readAmortizationSchedule — the long table", () => {
  const LONG_TABLE: string[][] = [
    ["Fecha", "Cuota Nº", "Cuota", "Capital", "Interés", "Extra", "Saldo"],
    ["01/06/2004", "", "3500", "3500", "", "3500", "169653,18"],
    ["01/07/2004", "1", "665,80", "296,46", "369,34", "", "163856,72"],
    ["01/08/2004", "2", "665,80", "297,13", "368,67", "", "163559,59"],
  ];

  test("bare «Capital» and «Interés» are money, never a balance or a rate", () => {
    const reading = read([
      ["", "01/05/2004", "01/05/2005"],
      ["Tipo", "2,70", "2,815"],
      ["Tabla de Amortización Ejecutada Préstamo Nº 0049"],
      ...LONG_TABLE,
    ]);

    // 296,46 € of principal never becomes a 2,9646 % rate, and 665,80 € never
    // becomes a balance: the only balances are the «Saldo» column's.
    expect(reading.revisions.map((revision) => revision.annualInterestRate)).toEqual([
      "0.027",
      "0.02815",
    ]);
    expect(reading.declaredBalances.map((balance) => balance.balanceMinor)).toEqual([
      16_965_318, 16_385_672, 16_355_959,
    ]);
  });

  test("the «Extra» column dates the lump, beating the matrix's yearly aggregate", () => {
    const reading = read([
      ["", "01/05/2004", "01/05/2005"],
      ["Interés", "0,027", "0,02815"],
      ["Amortiz Anticipada", "3500", ""],
      ...LONG_TABLE,
    ]);
    expect(reading.earlyRepayments).toEqual([
      { amountMinor: 350_000, repaymentDate: "2004-06-01" },
    ]);
  });

  test("an explicit rate column emits a revision only where the rate CHANGES", () => {
    const reading = read([
      ["Fecha", "Cuota", "Tipo", "Saldo"],
      ["01/07/2004", "665,80", "2,70", "163856,72"],
      ["01/08/2004", "665,80", "2,70", "163559,59"],
      ["01/09/2004", "665,80", "2,70", "163261,79"],
      ["01/05/2005", "670,00", "2,815", "160855,24"],
    ]);
    expect(reading.revisions).toEqual([
      { annualInterestRate: "0.027", revisionDate: "2004-07-01" },
      { annualInterestRate: "0.02815", revisionDate: "2005-05-01" },
    ]);
  });

  test("a header with nothing dated below it is words, not a table", () => {
    const result = readAmortizationSchedule([
      sheet([
        ["Fecha", "Tipo", "Saldo"],
        ["pendiente de recibir del banco", "", ""],
      ]),
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("readAmortizationSchedule — choosing the sheet", () => {
  test("the owner's analysis sheets are skipped and named", () => {
    const result = readAmortizationSchedule([
      sheet(
        [
          ["Ofertas de alquiler con opción a compra"],
          ["Piso", "Precio", "Renta"],
          ["Plasencia centro", "145000", "600"],
        ],
        "Análisis Abril-22",
      ),
      sheet(SANTANDER_MATRIX, "Cuadro"),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sheetName).toBe("Cuadro");
    expect(result.value.revisions).toHaveLength(3);
    expect(result.value.warnings).toEqual([
      "Leí la hoja «Cuadro». También vi «Análisis Abril-22», que no contienen un cuadro de amortización.",
    ]);
  });

  test("a workbook with no schedule anywhere fails with one Spanish message", () => {
    const result = readAmortizationSchedule([
      sheet(
        [
          ["Concepto", "Importe"],
          ["Luz", "62,10"],
        ],
        "Gastos",
      ),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("cuadro de amortización");
  });

  test("a CSV arrives as one unnamed sheet and warns about nothing", () => {
    const reading = read(SANTANDER_MATRIX);
    expect(reading.sheetName).toBe("");
    expect(reading.warnings).toEqual([]);
  });
});
