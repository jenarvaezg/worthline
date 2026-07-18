import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import { ATTACHMENT_EXTRACTION_LIMITS_V1 } from "./attachment-extraction-contract";
import {
  extractPositionsAndMovementsFromSpreadsheet,
  toIsoDate,
} from "./attachment-positions-movements-extractor";

function csvBytes(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}

function input(
  bytes: Uint8Array,
  fileName = "cartera.csv",
  mimeType = "text/csv",
): { bytes: Uint8Array; fileName: string; mimeType: string } {
  return { bytes, fileName, mimeType };
}

function inlineCell(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
}

function numericCell(ref: string, value: string): string {
  return `<c r="${ref}"><v>${value}</v></c>`;
}

function sheetXml(rows: string): string {
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

/** A two-sheet workbook: a holdings sheet and a movements sheet. */
function xlsxWithMovements(): Uint8Array {
  const holdings = sheetXml(
    `<row r="1">${inlineCell("A1", "Nombre")}${inlineCell("B1", "Tipo")}${inlineCell("C1", "ISIN")}${inlineCell("D1", "Valor")}${inlineCell("E1", "Divisa")}${inlineCell("F1", "Coste")}</row>
<row r="2">${inlineCell("A2", "Vanguard FTSE All-World")}${inlineCell("B2", "Fondo indexado")}${inlineCell("C2", "IE00B3RBWM25")}${numericCell("D2", "1234.56")}${inlineCell("E2", "EUR")}${numericCell("F2", "1000")}</row>
<row r="3">${inlineCell("A3", "Banco Santander")}${inlineCell("B3", "Acción")}${inlineCell("C3", "")}${numericCell("D3", "765.44")}${inlineCell("E3", "EUR")}${inlineCell("F3", "")}</row>`,
  );
  const movements = sheetXml(
    `<row r="1">${inlineCell("A1", "Fecha")}${inlineCell("B1", "Operación")}${inlineCell("C1", "ISIN")}${inlineCell("D1", "Unidades")}${inlineCell("E1", "Importe")}${inlineCell("F1", "Divisa")}</row>
<row r="2">${inlineCell("A2", "2026-01-15")}${inlineCell("B2", "Compra")}${inlineCell("C2", "IE00B3RBWM25")}${numericCell("D2", "10.5")}${numericCell("E2", "1000")}${inlineCell("F2", "EUR")}</row>`,
  );
  const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Posiciones" sheetId="1" r:id="rId1"/><sheet name="Movimientos" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
  return zipSync({
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/worksheets/sheet1.xml": strToU8(holdings),
    "xl/worksheets/sheet2.xml": strToU8(movements),
  });
}

describe("positions + movements spreadsheet extractor", () => {
  test("reads a CSV holdings snapshot as value_only (no movements, no cost)", () => {
    const bytes = csvBytes([
      "Nombre;Tipo;Valor;Divisa",
      "Vanguard FTSE All-World;Fondo indexado;1.234,56;EUR",
    ]);
    const result = extractPositionsAndMovementsFromSpreadsheet(input(bytes));

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.data.documentType !== "positions_movements") {
      throw new Error("expected a positions_movements document");
    }
    expect(result.data.holdings).toEqual([
      {
        currency: "EUR",
        fidelity: "value_only",
        name: "Vanguard FTSE All-World",
        type: "Fondo indexado",
        value: 1234.56,
      },
    ]);
    expect(result.data.movements).toEqual([]);
  });

  test("a declared cost with no movements is the declared_cost tier", () => {
    const bytes = csvBytes([
      "Nombre;Tipo;Valor;Divisa;Coste",
      "Piso Madrid;Inmueble;250000;EUR;180000",
    ]);
    const result = extractPositionsAndMovementsFromSpreadsheet(input(bytes));

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.data.documentType !== "positions_movements") {
      throw new Error("expected a positions_movements document");
    }
    expect(result.data.holdings[0]).toMatchObject({
      declaredCost: 180000,
      fidelity: "declared_cost",
    });
  });

  test("movements linked by ISIN promote a holding to the real cost-basis tier", () => {
    const result = extractPositionsAndMovementsFromSpreadsheet(
      input(
        xlsxWithMovements(),
        "cartera.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    );

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.data.documentType !== "positions_movements") {
      throw new Error("expected a positions_movements document");
    }
    const withMovements = result.data.holdings.find(
      (holding) => holding.isin === "IE00B3RBWM25",
    );
    expect(withMovements?.fidelity).toBe("movements");
    // The Santander row has neither movement nor cost — honest value-only.
    const valueOnly = result.data.holdings.find((holding) =>
      holding.name.includes("Santander"),
    );
    expect(valueOnly?.fidelity).toBe("value_only");
    expect(result.data.movements).toEqual([
      {
        amount: 1000,
        currency: "EUR",
        date: "2026-01-15",
        isin: "IE00B3RBWM25",
        kind: "buy",
        units: 10.5,
      },
    ]);
  });

  test("a malformed ISIN is dropped with a visible warning, never guessed", () => {
    const bytes = csvBytes([
      "Nombre;Tipo;ISIN;Valor;Divisa",
      "Fondo raro;Fondo;NO-ISIN;1000;EUR",
    ]);
    const result = extractPositionsAndMovementsFromSpreadsheet(input(bytes));

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.data.documentType !== "positions_movements") {
      throw new Error("expected a positions_movements document");
    }
    expect(result.data.holdings[0]).toMatchObject({ uncertain: true });
    expect(result.data.holdings[0]).not.toHaveProperty("isin");
    expect(result.data.warnings.join(" ")).toContain("ISIN");
  });

  test("links movements to holdings across dd/mm/yyyy dates (real Excel serials)", () => {
    const holdings = sheetXml(
      `<row r="1">${inlineCell("A1", "Nombre")}${inlineCell("B1", "Tipo")}${inlineCell("C1", "ISIN")}${inlineCell("D1", "Valor")}${inlineCell("E1", "Divisa")}</row>
<row r="2">${inlineCell("A2", "Vanguard FTSE All-World")}${inlineCell("B2", "Fondo")}${inlineCell("C2", "IE00B3RBWM25")}${numericCell("D2", "1234.56")}${inlineCell("E2", "EUR")}</row>`,
    );
    const movements = sheetXml(
      `<row r="1">${inlineCell("A1", "Fecha")}${inlineCell("B1", "Operación")}${inlineCell("C1", "ISIN")}${inlineCell("D1", "Importe")}${inlineCell("E1", "Divisa")}</row>
<row r="2">${inlineCell("A2", "15/01/2026")}${inlineCell("B2", "Compra")}${inlineCell("C2", "IE00B3RBWM25")}${numericCell("D2", "1000")}${inlineCell("E2", "EUR")}</row>`,
    );
    const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="P" sheetId="1" r:id="rId1"/><sheet name="M" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
    const bytes = zipSync({
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/workbook.xml": strToU8(workbook),
      "xl/worksheets/sheet1.xml": strToU8(holdings),
      "xl/worksheets/sheet2.xml": strToU8(movements),
    });
    const result = extractPositionsAndMovementsFromSpreadsheet(
      input(
        bytes,
        "cartera.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    );

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.data.documentType !== "positions_movements") {
      throw new Error("expected a positions_movements document");
    }
    expect(result.data.movements[0]?.date).toBe("2026-01-15");
    expect(result.data.holdings[0]?.fidelity).toBe("movements");
  });

  test("skips an unrecognized operation with a warning — no invented movement kind", () => {
    const holdings = sheetXml(
      `<row r="1">${inlineCell("A1", "Nombre")}${inlineCell("B1", "Tipo")}${inlineCell("C1", "Valor")}${inlineCell("D1", "Divisa")}</row>
<row r="2">${inlineCell("A2", "Fondo")}${inlineCell("B2", "Fondo")}${numericCell("C2", "1000")}${inlineCell("D2", "EUR")}</row>`,
    );
    const movements = sheetXml(
      `<row r="1">${inlineCell("A1", "Fecha")}${inlineCell("B1", "Operación")}${inlineCell("C1", "Nombre")}${inlineCell("D1", "Importe")}${inlineCell("E1", "Divisa")}</row>
<row r="2">${inlineCell("A2", "2026-01-15")}${inlineCell("B2", "Rebalanceo")}${inlineCell("C2", "Fondo")}${numericCell("D2", "50")}${inlineCell("E2", "EUR")}</row>`,
    );
    const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="P" sheetId="1" r:id="rId1"/><sheet name="M" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
    const bytes = zipSync({
      "xl/_rels/workbook.xml.rels": strToU8(rels),
      "xl/workbook.xml": strToU8(workbook),
      "xl/worksheets/sheet1.xml": strToU8(holdings),
      "xl/worksheets/sheet2.xml": strToU8(movements),
    });
    const result = extractPositionsAndMovementsFromSpreadsheet(
      input(
        bytes,
        "cartera.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    );

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.data.documentType !== "positions_movements") {
      throw new Error("expected a positions_movements document");
    }
    expect(result.data.movements).toEqual([]);
    expect(result.data.holdings[0]?.fidelity).toBe("value_only");
    expect(result.data.warnings.join(" ")).toContain("Rebalanceo");
  });

  test("skips a subtotal-style row missing its currency, keeping the real holdings", () => {
    const bytes = csvBytes([
      "Nombre;Tipo;Valor;Divisa",
      "Fondo bueno;Fondo;1000;EUR",
      "Total;;1000;",
    ]);
    const result = extractPositionsAndMovementsFromSpreadsheet(input(bytes));

    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.data.documentType !== "positions_movements") {
      throw new Error("expected a positions_movements document");
    }
    expect(result.data.holdings).toHaveLength(1);
    expect(result.data.holdings[0]?.name).toBe("Fondo bueno");
    expect(result.data.warnings.join(" ")).toContain("omitido");
  });

  test("falls back to unrecognized when no row yields a usable holding", () => {
    const bytes = csvBytes(["Nombre;Tipo;Valor;Divisa", "Total;;;"]);
    const result = extractPositionsAndMovementsFromSpreadsheet(input(bytes));
    expect(result.status).toBe("unrecognized");
  });

  test("a sheet without the required headers is unrecognized, not a failure", () => {
    const bytes = csvBytes([
      "Símbolo;Nombre;Unidades;Valor de mercado EUR;Divisa",
      "VWCE;Vanguard;10;1234;EUR",
    ]);
    const result = extractPositionsAndMovementsFromSpreadsheet(input(bytes));
    expect(result.status).toBe("unrecognized");
  });

  test("toIsoDate reformats dd/mm/yyyy and rejects an impossible day", () => {
    expect(toIsoDate("15/01/2026")).toBe("2026-01-15");
    expect(toIsoDate("5/1/2026")).toBe("2026-01-05");
    expect(toIsoDate("2026-01-15")).toBe("2026-01-15");
    expect(toIsoDate("32/13/2026")).toBeNull();
    expect(toIsoDate("30 de junio")).toBeNull();
  });

  test("enforces the shared row limit across holdings and movements", () => {
    const lines = ["Nombre;Tipo;Valor;Divisa"];
    for (let i = 0; i < ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows + 1; i += 1) {
      lines.push(`Fondo ${i};Fondo;100;EUR`);
    }
    const result = extractPositionsAndMovementsFromSpreadsheet(input(csvBytes(lines)));
    expect(result).toMatchObject({ reason: "rows", status: "out_of_limits" });
  });
});
