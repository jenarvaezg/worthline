import { describe, expect, test } from "vitest";

import { extractSpreadsheetDocument } from "./attachment-spreadsheet-dispatch";

function csvBytes(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}

function input(bytes: Uint8Array, fileName = "hoja.csv") {
  return { bytes, fileName, mimeType: "text/csv" };
}

describe("spreadsheet document dispatch", () => {
  test("recognizes a positions + movements portfolio sheet", () => {
    const bytes = csvBytes([
      "Nombre;Tipo;Valor;Divisa",
      "Vanguard FTSE All-World;Fondo indexado;1234,56;EUR",
    ]);
    const result = extractSpreadsheetDocument(input(bytes));
    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.data.documentType).toBe("positions_movements");
  });

  test("falls back to the broker positions table the reconcile sheet does not match", () => {
    const bytes = csvBytes([
      "Símbolo;Nombre;Unidades;Valor de mercado EUR;Divisa",
      "VWCE;Vanguard FTSE All-World;10;1234.56;EUR",
    ]);
    const result = extractSpreadsheetDocument(input(bytes));
    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.data.documentType).toBe("positions");
  });

  test("a sheet neither recognizer knows stays unrecognized for the unstructured path", () => {
    const bytes = csvBytes(["Cabecera cualquiera;Otra", "un valor;otro"]);
    expect(extractSpreadsheetDocument(input(bytes)).status).toBe("unrecognized");
  });
});
