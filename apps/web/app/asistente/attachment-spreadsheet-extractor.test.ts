import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import { ATTACHMENT_EXTRACTION_LIMITS_V1 } from "./attachment-extraction-contract";
import { extractPositionsFromSpreadsheet } from "./attachment-spreadsheet-extractor";

const HEADER = "Símbolo;Nombre;Unidades;Valor de mercado EUR;Divisa";

function csvBytes(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}

function input(bytes: Uint8Array, fileName = "posiciones.csv", mimeType = "text/csv") {
  return { bytes, fileName, mimeType };
}

function inlineCell(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
}

function numericCell(ref: string, value: string): string {
  return `<c r="${ref}"><v>${value}</v></c>`;
}

function xlsxFixture(): Uint8Array {
  const firstSheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${inlineCell("A1", "TICKER")}${inlineCell("B1", "  Descripción  ")}${inlineCell("C1", "Títulos")}${inlineCell("D1", "Valor   EUR")}${inlineCell("E1", "Moneda")}</row>
<row r="2">${inlineCell("A2", "VWCE")}${inlineCell("B2", "Vanguard FTSE All-World")}${numericCell("C2", "10.5")}${numericCell("D2", "1234.56")}${inlineCell("E2", "EUR")}</row>
<row r="3">${inlineCell("A3", "SAN")}${inlineCell("B3", "Banco Santander")}${numericCell("C3", "20")}${numericCell("D3", "765.44")}${inlineCell("E3", "EUR")}</row>
</sheetData></worksheet>`;
  const ignoredSheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${inlineCell("A1", "No debe leerse")}</row></sheetData></worksheet>`;
  const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Posiciones" sheetId="1" r:id="rId2"/><sheet name="Otra" sheetId="2" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
  return zipSync({
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/worksheets/sheet1.xml": strToU8(ignoredSheet),
    "xl/worksheets/sheet2.xml": strToU8(firstSheet),
  });
}

const EXPECTED_VALID = {
  data: {
    documentType: "positions",
    positions: [
      {
        currency: "EUR",
        marketValueEur: 1234.56,
        name: "Vanguard FTSE All-World",
        ticker: "VWCE",
        units: 10.5,
      },
      {
        currency: "EUR",
        marketValueEur: 765.44,
        name: "Banco Santander",
        ticker: "SAN",
        units: 20,
      },
    ],
    totalEur: 2000,
    warnings: [],
  },
  status: "valid",
} as const;

describe("extractPositionsFromSpreadsheet", () => {
  test("maps Spanish headers and numbers from quote-aware semicolon CSV", () => {
    const result = extractPositionsFromSpreadsheet(
      input(csvBytes([HEADER, 'VWCE;"Vanguard; FTSE All-World";"10,5";"1.234,56";EUR'])),
    );

    expect(result).toEqual({
      data: {
        documentType: "positions",
        positions: [
          {
            currency: "EUR",
            marketValueEur: 1234.56,
            name: "Vanguard; FTSE All-World",
            ticker: "VWCE",
            units: 10.5,
          },
        ],
        totalEur: 1234.56,
        warnings: [],
      },
      status: "valid",
    });
  });

  test("supports comma and tab delimiters through the same header mapper", () => {
    const comma = csvBytes([
      "symbol,name,quantity,market value eur,currency",
      "VWCE,Vanguard,10.5,1234.56,EUR",
    ]);
    const tab = csvBytes([
      "ticker\tinstrumento\tparticipaciones\timporte eur\tdivisa",
      "VWCE\tVanguard\t10.5\t1234.56\tEUR",
    ]);

    expect(extractPositionsFromSpreadsheet(input(comma)).status).toBe("valid");
    expect(extractPositionsFromSpreadsheet(input(tab)).status).toBe("valid");
  });

  test("returns typed unrecognized for unknown or missing headers", () => {
    expect(
      extractPositionsFromSpreadsheet(
        input(csvBytes(["Código;Producto;Saldo", "VWCE;Vanguard;100"])),
      ),
    ).toEqual({
      message:
        "No reconozco las cabeceras de esta hoja de posiciones. Revisa que incluya símbolo, nombre, unidades, valor de mercado en EUR y divisa.",
      status: "unrecognized",
    });
  });

  test("rejects a malformed data row as a permanent failure", () => {
    expect(
      extractPositionsFromSpreadsheet(
        input(csvBytes([HEADER, "VWCE;Vanguard;diez;1.234,56;EUR"])),
      ),
    ).toEqual({
      code: "extractor_rejected",
      failure: "permanent",
      message: "La fila 2 contiene datos incompletos o no válidos.",
      status: "failure",
    });
  });

  test("accepts 500 data rows and rejects 501 through the shared limit seam", () => {
    const row = "VWCE;Vanguard;1;1;EUR";
    const accepted = extractPositionsFromSpreadsheet(
      input(csvBytes([HEADER, ...Array.from({ length: 500 }, () => row)])),
    );
    const rejected = extractPositionsFromSpreadsheet(
      input(csvBytes([HEADER, ...Array.from({ length: 501 }, () => row)])),
    );

    expect(ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows).toBe(500);
    expect(accepted.status).toBe("valid");
    expect(rejected).toEqual({
      message: "La hoja supera el límite de 500 filas.",
      reason: "rows",
      status: "out_of_limits",
    });
  });

  test("turns an unreadable XLSX into an honest permanent failure", () => {
    expect(
      extractPositionsFromSpreadsheet(
        input(
          strToU8("not a workbook"),
          "posiciones.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
      ),
    ).toEqual({
      code: "unsupported_document",
      failure: "permanent",
      message: "El archivo XLSX no se puede leer.",
      status: "failure",
    });
  });

  test("maps the real first XLSX sheet to the same structured result as CSV", () => {
    const csv = csvBytes([
      "ticker;name;units;market value eur;currency",
      "VWCE;Vanguard FTSE All-World;10.5;1234.56;EUR",
      "SAN;Banco Santander;20;765.44;EUR",
    ]);
    const fromCsv = extractPositionsFromSpreadsheet(input(csv));
    const fromXlsx = extractPositionsFromSpreadsheet(
      input(
        xlsxFixture(),
        "posiciones.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    );

    expect(fromCsv).toEqual(EXPECTED_VALID);
    expect(fromXlsx).toEqual(fromCsv);
  });
});
