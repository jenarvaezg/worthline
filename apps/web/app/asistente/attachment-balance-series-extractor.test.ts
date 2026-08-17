import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import { extractBalanceSeriesFromSpreadsheet } from "./attachment-balance-series-extractor";
import { ATTACHMENT_EXTRACTION_LIMITS_V1 } from "./attachment-extraction-contract";

function csvBytes(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}

function input(
  bytes: Uint8Array,
  fileName = "cuadro.csv",
  mimeType = "text/csv",
): { bytes: Uint8Array; fileName: string; mimeType: string } {
  return { bytes, fileName, mimeType };
}

function balanceSeries(bytes: Uint8Array, fileName?: string, mimeType?: string) {
  const result = extractBalanceSeriesFromSpreadsheet(input(bytes, fileName, mimeType));
  if (result.status !== "valid") {
    throw new Error(`expected valid, got ${result.status}`);
  }
  if (result.data.documentType !== "balance_series") {
    throw new Error(`expected balance_series, got ${result.data.documentType}`);
  }
  return result.data;
}

function inlineCell(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
}

function sheetXml(rows: readonly string[][], firstRow = 1): string {
  const body = rows
    .map((cells, index) => {
      const row = firstRow + index;
      const inline = cells
        .map((value, column) =>
          value === ""
            ? ""
            : inlineCell(`${String.fromCharCode(65 + column)}${row}`, value),
        )
        .join("");
      return `<row r="${row}">${inline}</row>`;
    })
    .join("");
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** A workbook of named sheets, in order, from plain cell matrices. */
function xlsxBytes(sheets: readonly { name: string; rows: string[][] }[]): Uint8Array {
  const declarations = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${declarations}</sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("")}</Relationships>`;
  return zipSync({
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/workbook.xml": strToU8(workbook),
    ...Object.fromEntries(
      sheets.map((sheet, index) => [
        `xl/worksheets/sheet${index + 1}.xml`,
        strToU8(sheetXml(sheet.rows)),
      ]),
    ),
  });
}

describe("balance series spreadsheet extractor", () => {
  test("reads a dated balance table with an explicit currency column", () => {
    const data = balanceSeries(
      csvBytes([
        "Fecha;Saldo pendiente;Divisa",
        "01/06/2004;169.653,18;EUR",
        "01/07/2004;163.856,72;EUR",
      ]),
    );
    expect(data.balances).toEqual([
      { amount: 169_653.18, currency: "EUR", date: "2004-06-01" },
      { amount: 163_856.72, currency: "EUR", date: "2004-07-01" },
    ]);
    expect(data.warnings).toEqual([]);
    expect(data.uncertain).toBeUndefined();
  });

  test("finds the header below the preamble rows of a real bank schedule", () => {
    const data = balanceSeries(
      csvBytes([
        ";01/05/2004;01/05/2005",
        "Capital;173153.18;160855.24",
        "Interés;0,027;0,02815",
        "Plazo;360",
        "Amortiz Anticipada;;1803,04",
        "Tabla de Amortización Ejecutada Préstamo Nº 0049",
        "Fecha;Cuota Nº;Cuota;Capital;Interés;Extra;Saldo",
        "01/06/2004;;3500;3500;;;169653,18",
        "01/07/2004;1;665,80;296,46;369,34;;163856,72",
      ]),
    );
    expect(data.balances.map((balance) => balance.date)).toEqual([
      "2004-06-01",
      "2004-07-01",
    ]);
    expect(data.balances[0]?.amount).toBe(169_653.18);
  });

  test("bare «Capital» is the principal paid, never the outstanding balance", () => {
    const result = extractBalanceSeriesFromSpreadsheet(
      input(csvBytes(["Fecha;Cuota;Capital;Interés", "01/07/2004;665,80;296,46;369,34"])),
    );
    expect(result.status).toBe("unrecognized");
  });

  test("several named products under one date is a snapshot, not a series", () => {
    // The eval's «apuntes de la familia»: reading this as a series would drop the one
    // column that says what each figure belongs to.
    const result = extractBalanceSeriesFromSpreadsheet(
      input(
        csvBytes([
          "Concepto;Saldo;Fecha",
          "Cuenta corriente conjunta;12.930,44;31/05/2026",
          "Hipoteca vivienda;-183.512,90;31/05/2026",
        ]),
      ),
    );
    expect(result.status).toBe("unrecognized");
  });

  test("one product named on every row is still its own series", () => {
    const data = balanceSeries(
      csvBytes([
        "Concepto;Saldo;Fecha",
        "Hipoteca Plasencia;169.653,18;01/06/2004",
        "Hipoteca Plasencia;163.856,72;01/07/2004",
      ]),
    );
    expect(data.balances).toHaveLength(2);
  });

  test("skips the gaps of a sparse balance column in silence and keeps a zero", () => {
    const data = balanceSeries(
      csvBytes([
        "Fecha;Saldo",
        "01/06/2004;169653,18",
        "01/07/2004;",
        "01/08/2004;-",
        "01/06/2034;0",
      ]),
    );
    expect(data.balances).toHaveLength(2);
    expect(data.balances[1]).toEqual({
      amount: 0,
      currency: "EUR",
      date: "2034-06-01",
    });
    expect(data.warnings).toEqual([expect.stringContaining("no indica la divisa")]);
  });

  test("warns on a balance the sheet printed and we could not read", () => {
    const data = balanceSeries(
      csvBytes(["Fecha;Saldo", "01/06/2004;169653,18", "01/07/2004;12.34.56"]),
    );
    expect(data.balances).toHaveLength(1);
    expect(data.warnings).toContain(
      "Fila 3: el saldo «12.34.56» no es un número; se ha omitido.",
    );
  });

  test("warns on an unreadable date next to a printed balance", () => {
    const data = balanceSeries(
      csvBytes(["Fecha;Saldo", "01/06/2004;169653,18", "junio de 2004;163856,72"]),
    );
    expect(data.balances).toHaveLength(1);
    expect(data.warnings).toContain(
      "Fila 3: la fecha no es una fecha válida; se ha omitido.",
    );
  });

  test("warns and skips a row whose currency column is not a three-letter code", () => {
    const data = balanceSeries(
      csvBytes([
        "Fecha;Saldo;Divisa",
        "01/06/2004;169653,18;EUR",
        "01/07/2004;163856,72;Euros",
      ]),
    );
    expect(data.balances).toHaveLength(1);
    expect(data.warnings).toContain(
      "Fila 3: la divisa «EUROS» no es un código de tres letras; se ha omitido.",
    );
  });

  test("takes the currency the balance header printed", () => {
    const data = balanceSeries(
      csvBytes(["Fecha;Capital pendiente (£);", "01/06/2004;169653,18"]),
    );
    expect(data.balances[0]?.currency).toBe("GBP");
    expect(data.warnings).toEqual([]);
    expect(data.uncertain).toBeUndefined();
  });

  test("takes the currency printed inside the balance cell", () => {
    const data = balanceSeries(csvBytes(["Fecha;Saldo", "01/06/2004;169.653,18 €"]));
    expect(data.balances[0]).toEqual({
      amount: 169_653.18,
      currency: "EUR",
      date: "2004-06-01",
    });
    expect(data.warnings).toEqual([]);
  });

  test("a sheet that prints no currency is read in EUR, said out loud and marked", () => {
    const data = balanceSeries(csvBytes(["Fecha;Saldo", "01/06/2004;169653,18"]));
    expect(data.balances[0]?.currency).toBe("EUR");
    expect(data.uncertain).toBe(true);
    expect(data.warnings[0]).toContain("se han leído en EUR");
  });

  test("a sheet with no dated balance table stays unrecognized", () => {
    const result = extractBalanceSeriesFromSpreadsheet(
      input(csvBytes(["Concepto;Importe", "Comisión;12,50"])),
    );
    expect(result.status).toBe("unrecognized");
    if (result.status !== "unrecognized") throw new Error("expected unrecognized");
    expect(result.message).toContain("saldos fechados");
  });

  test("a header row with no readable observation under it is not the table", () => {
    const result = extractBalanceSeriesFromSpreadsheet(
      input(csvBytes(["Fecha;Saldo", "sin fecha;sin saldo"])),
    );
    expect(result.status).toBe("unrecognized");
  });

  test("counts observations, not sheet rows, against the row limit", () => {
    const lines = ["Fecha;Saldo"];
    for (let index = 0; index < 600; index += 1) {
      // A monthly schedule the bank stamps a balance on twice a year: 600 rows,
      // 100 observations — well inside the bound that used to measure the sheet.
      lines.push(`01/06/2004;${index % 6 === 0 ? "169653,18" : ""}`);
    }
    expect(balanceSeries(csvBytes(lines)).balances).toHaveLength(100);
  });

  test("refuses a series above the contract's row limit", () => {
    const lines = ["Fecha;Saldo"];
    for (let index = 0; index <= ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows; index += 1) {
      lines.push(`01/06/2004;${1000 + index}`);
    }
    const result = extractBalanceSeriesFromSpreadsheet(input(csvBytes(lines)));
    expect(result.status).toBe("out_of_limits");
    if (result.status !== "out_of_limits") throw new Error("expected out_of_limits");
    expect(result.reason).toBe("rows");
  });

  test("caps the warnings at the contract's bound and says how many are hidden", () => {
    const lines = ["Fecha;Saldo", "01/06/2004;169653,18"];
    for (let index = 0; index < 30; index += 1) {
      lines.push(`01/07/2004;12.34.56`);
    }
    const data = balanceSeries(csvBytes(lines));
    expect(data.warnings).toHaveLength(ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings);
    expect(data.warnings.at(-1)).toContain("avisos más sin mostrar");
  });

  test("sweeps the whole workbook: a table on a later sheet is still read", () => {
    const bytes = xlsxBytes([
      { name: "Portada", rows: [["Hipoteca de Plasencia"], ["Nada que leer aquí"]] },
      {
        name: "Plan Amortización",
        rows: [
          ["Fecha", "Saldo", "Divisa"],
          ["01/06/2004", "169653,18", "EUR"],
        ],
      },
    ]);
    const data = balanceSeries(
      bytes,
      "plan.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(data.balances).toHaveLength(1);
    expect(data.warnings).toEqual([]);
  });

  test("names the sheet it read when another one also carries dated balances", () => {
    const bytes = xlsxBytes([
      {
        name: "Plan Amortización",
        rows: [
          ["Fecha", "Saldo", "Divisa"],
          ["01/06/2004", "169653,18", "EUR"],
        ],
      },
      {
        name: "Hipoteca Bea",
        rows: [
          ["Cuota Nº", "Saldo", "Fecha", "Divisa"],
          ["1", "166788,50", "04/04/2007", "EUR"],
        ],
      },
    ]);
    const data = balanceSeries(
      bytes,
      "plan.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(data.balances).toHaveLength(1);
    expect(data.warnings).toEqual([
      "He leído los saldos de la hoja «Plan Amortización»; «Hipoteca Bea» también parece llevar saldos fechados y no se ha leído.",
    ]);
  });
});
