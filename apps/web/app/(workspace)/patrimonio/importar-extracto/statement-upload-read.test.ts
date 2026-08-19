import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import { readStatementUpload, STATEMENT_GATE_FORMATS } from "./statement-upload-read";

/** The plantilla (#695) — the format the gate has always spoken. */
const PLANTILLA = [
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
  "05/01/2024;Fondo;ES00WL000001;Compra;34,2857;1200;;",
].join("\r\n");

/**
 * A DEGIRO `Transactions.xlsx` as CSV: 17 columns, Spanish header, `Fecha` DD-MM-YYYY,
 * signed `Número` (the sign IS the operation), currency in header-less columns, costs
 * and total in EUR, `ID Orden` last. The shape is the measured one (#1487's fixture).
 */
const DEGIRO = [
  "Fecha;Hora;Producto;ISIN;Bolsa de referencia;Centro de ejecución;Número;Precio;;Valor local;;Valor EUR;Tipo de cambio;Comisión AutoFX;Costes de transacción y/o externos EUR;Total EUR;ID Orden",
  "12-02-2026;09:04;ISHARES CORE S&P 500;IE00B5BMR087;EAM;XAMS;3;187,48;EUR;-562,44;EUR;-562,44;;;-1,00;-563,44;aa11",
  "03-03-2026;10:15;ISHARES CORE S&P 500;IE00B5BMR087;EAM;XAMS;-2;190,00;EUR;380,00;EUR;380,00;;;-1,00;379,00;bb22",
].join("\n");

function read(text: string, fileName = "extracto.csv") {
  return readStatementUpload({
    broker: "plantilla",
    bytes: new TextEncoder().encode(text),
    fileName,
  });
}

describe("readStatementUpload", () => {
  test("reads the plantilla, as it always did", () => {
    const result = read(PLANTILLA, "plantilla.csv");

    if (!result.ok) throw new Error(result.message);
    expect(result.statement.rows).toHaveLength(1);
    expect(result.statement.isins).toEqual(["ES00WL000001"]);
    expect(result.warnings).toEqual([]);
  });

  test("reads a broker transactions export the plantilla does not recognize (#1488)", () => {
    const result = read(DEGIRO, "Transactions.csv");

    if (!result.ok) throw new Error(result.message);
    expect(result.statement.rows.map((row) => row.kind)).toEqual(["buy", "sell"]);
    expect(result.statement.rows[0]).toMatchObject({
      dateKey: "2026-02-12",
      feesMinor: 100,
      isin: "IE00B5BMR087",
      pricePerUnit: "187.48",
      units: "3",
    });
  });

  test("reads a broker transactions export out of an .xlsx", () => {
    const cells = (row: number, values: string[]) =>
      `<row r="${row}">${values
        .map(
          (value, index) =>
            `<c r="${String.fromCharCode(65 + index)}${row}" t="inlineStr"><is><t>${value}</t></is></c>`,
        )
        .join("")}</row>`;
    const sheet =
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      cells(1, ["Fecha", "Producto", "ISIN", "Número", "Precio", "Total EUR"]) +
      cells(2, ["12-02-2026", "SXR1", "IE00B5BMR087", "3", "187,48", "-563,44"]) +
      `</sheetData></worksheet>`;
    const xlsx = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) });

    const result = readStatementUpload({
      broker: "plantilla",
      bytes: new Uint8Array(xlsx),
      fileName: "Transactions.xlsx",
    });

    if (!result.ok) throw new Error(result.message);
    expect(result.statement.rows).toHaveLength(1);
    expect(result.statement.rows[0]?.isin).toBe("IE00B5BMR087");
  });

  test("a malformed plantilla keeps its own all-or-nothing error, never a second reading", () => {
    // The generic reader WOULD resolve this header (Fecha · Participaciones · Importe ·
    // Nombre), so without the header guard a plantilla with one broken row would come
    // back as an unrelated complaint instead of «esta fila está mal» (ADR 0010).
    const broken = [
      "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre",
      "05/01/2024;Fondo;ES00WL000001;Compra;no son participaciones;1200;;",
    ].join("\n");
    const result = read(broken);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("2");
  });

  test("a file neither reader recognizes names BOTH formats it could have been", () => {
    const result = read("Columna A;Columna B\nun valor;otro valor");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("plantilla");
    expect(result.message).toContain("transacciones");
  });

  test("an empty file says so, without guessing at a format", () => {
    const result = read("");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("vacío");
  });

  test("a transactions table whose trades carry no ISIN is refused by name, not read half", () => {
    const withoutIsin = [
      "Fecha;Producto;Número;Precio;Total EUR",
      "12-02-2026;SXR1;3;187,48;-563,44",
    ].join("\n");
    const result = read(withoutIsin);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("ISIN");
  });

  test("the reading's doubts travel out as warnings, for the gate to show", () => {
    // No sign and no operation column: every row reads as a buy, and it must be said.
    const allBuys = [
      "Fecha;ISIN;Producto;Número;Precio",
      "12-02-2026;IE00B5BMR087;SXR1;3;187,48",
    ].join("\n");
    const result = read(allBuys);

    if (!result.ok) throw new Error(result.message);
    expect(result.statement.directionResolved).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("the assumed-buy doubt is said ONCE, not twice, when the reader already said it", () => {
    const allBuys = [
      "Fecha;ISIN;Producto;Número;Precio",
      "12-02-2026;IE00B5BMR087;SXR1;3;187,48",
    ].join("\n");
    const result = read(allBuys);

    if (!result.ok) throw new Error(result.message);
    const said = result.warnings.filter((warning) =>
      warning.includes("compra o una venta"),
    );
    expect(said).toHaveLength(1);
  });

  test("an unreadable workbook is a message, not a throw", () => {
    const result = readStatementUpload({
      broker: "plantilla",
      // Zip magic bytes with nothing behind them.
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
      fileName: "roto.xlsx",
    });

    expect(result.ok).toBe(false);
  });
});

describe("STATEMENT_GATE_FORMATS", () => {
  test("names every format the gate reads, and is what the assistant is told", () => {
    // The list exists so nobody — model or human — has to guess (#1488): the assistant
    // sent a user here promising a DEGIRO import the gate could not do.
    expect(STATEMENT_GATE_FORMATS).toContain("la plantilla de worthline");
    expect(STATEMENT_GATE_FORMATS.length).toBeGreaterThan(1);
  });
});
