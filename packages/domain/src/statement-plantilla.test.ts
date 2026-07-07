import { describe, expect, test } from "vitest";

import { multiplyToMinor } from "./decimal";
import {
  findStatementTypeConflict,
  groupStatementRowsByIsin,
  isIsinShaped,
  resolveStatementImportBuckets,
} from "./statement-import-plan";
import { parseStatement } from "./statement-parse";

/**
 * The plantilla (#695): Worthline's own universal statement format — several
 * asset types in one file, direction explicit in `Operación`, amounts always
 * positive.
 */

const HEADER =
  "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe;Comisión;Nombre";

function parsedOk(rawText: string) {
  const result = parseStatement(rawText, "plantilla");
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${result.errors.join(" | ")}`);
  }
  return result.value;
}

describe("parseStatement — plantilla (#695)", () => {
  test("one file mixes asset types, each row declaring its own instrument", () => {
    const { rows, directionResolved } = parsedOk(
      [
        HEADER,
        "01/02/2026;Fondo;IE00BYX5NX33;Compra;7,226;100;;Fidelity MSCI World",
        "18/06/2026;Fondo;LU0208853274;Venta;62;1943,08;;",
        "15/03/2026;Cripto;bitcoin;Compra;0,015;850;1,5;Bitcoin",
        "2026-01-02;Plan de pensiones;N5572-myinvestor;Compra;9,044;119.38;;Mi plan",
        "05/04/2026;Acción;ES0105589008;Compra;20;63,71;;Endurance Motive",
      ].join("\n"),
    );

    expect(directionResolved).toBe(true);
    expect(rows.map((row) => row.kind)).toEqual(["buy", "sell", "buy", "buy", "buy"]);
    expect(rows.map((row) => row.instrument)).toEqual([
      "fund",
      "fund",
      "crypto",
      "pension_plan",
      "stock",
    ]);
    // CoinGecko ids keep their case — grouping/matching depend on it.
    expect(rows[2]!.isin).toBe("bitcoin");
    expect(rows[2]!.feesMinor).toBe(150);
    // Both date shapes land as ISO date keys.
    expect(rows[3]!.dateKey).toBe("2026-01-02");
    // Comma and dot decimals both parse; price derives amount ÷ units.
    expect(multiplyToMinor(rows[0]!.units, rows[0]!.pricePerUnit)).toBe(100_00);
    expect(multiplyToMinor(rows[3]!.units, rows[3]!.pricePerUnit)).toBe(119_38);
    // Nombre travels for creation prefill.
    expect(rows[0]!.name).toBe("Fidelity MSCI World");
    expect(rows[1]!.name).toBeUndefined();
  });

  test("quoted cells survive a `;` inside a name (Excel es-ES output)", () => {
    const { rows } = parsedOk(
      [
        HEADER,
        '01/02/2026;Fondo;IE00BYX5NX33;Compra;1;100;;"Cartera; la de siempre"',
      ].join("\n"),
    );

    expect(rows[0]!.name).toBe("Cartera; la de siempre");
  });

  test("a negative amount is a row error — direction only lives in Operación", () => {
    const result = parseStatement(
      [HEADER, "01/02/2026;Fondo;IE00BYX5NX33;Venta;1;-100;;"].join("\n"),
      "plantilla",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors[0]).toContain("importe inválido");
  });

  test("unknown tipo, unknown operación and mixed decimal separators abort the load", () => {
    for (const row of [
      "01/02/2026;Inmueble;IE00BYX5NX33;Compra;1;100;;",
      "01/02/2026;Fondo;IE00BYX5NX33;Traspaso;1;100;;",
      "01/02/2026;Fondo;IE00BYX5NX33;Compra;1;1.943,08;;",
      "40/02/2026;Fondo;IE00BYX5NX33;Compra;1;100;;",
      "01/02/2026;Fondo;;Compra;1;100;;",
    ]) {
      expect(parseStatement([HEADER, row].join("\n"), "plantilla").ok).toBe(false);
    }
  });

  test("tipo and operación are accent/case-insensitive; Comisión and Nombre are optional columns", () => {
    const { rows } = parsedOk(
      [
        "Fecha;Tipo de activo;Identificador;Operación;Participaciones;Importe",
        "01/02/2026;fondo;IE00BYX5NX33;COMPRA;1;100",
        "02/02/2026;INDICE;IE00BYX5NX34;venta;2;50",
      ].join("\n"),
    );

    expect(rows.map((row) => row.kind)).toEqual(["buy", "sell"]);
    expect(rows[1]!.instrument).toBe("index");
    expect(rows[0]!.feesMinor).toBe(0);
  });

  test("a missing required column names it and points at the template", () => {
    const result = parseStatement(
      ["Fecha;Identificador;Operación;Participaciones;Importe", ""].join("\n"),
      "plantilla",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors[0]).toContain("Tipo de activo");
    expect(result.errors[0]).toContain("plantilla");
  });
});

describe("statement grouping and matching with plantilla identifiers", () => {
  test("isIsinShaped separates ISINs from plan codes and coin ids", () => {
    expect(isIsinShaped("IE00BYX5NX33")).toBe(true);
    expect(isIsinShaped("bitcoin")).toBe(false);
    expect(isIsinShaped("N5572-myinvestor")).toBe(false);
  });

  test("a group carries its rows' instrument, and a two-type identifier is a conflict", () => {
    const clean = groupStatementRowsByIsin(
      parsedOk(
        [
          HEADER,
          "01/02/2026;Cripto;bitcoin;Compra;0,01;500;;",
          "02/02/2026;Cripto;bitcoin;Compra;0,01;520;;",
        ].join("\n"),
      ),
    );
    expect(clean[0]!.instrument).toBe("crypto");
    expect(findStatementTypeConflict(clean)).toBeNull();

    const mixed = groupStatementRowsByIsin(
      parsedOk(
        [
          HEADER,
          "01/02/2026;Fondo;IE00BYX5NX33;Compra;1;100;;",
          "02/02/2026;ETF;IE00BYX5NX33;Compra;1;100;;",
        ].join("\n"),
      ),
    );
    expect(findStatementTypeConflict(mixed)).toBe("IE00BYX5NX33");
  });

  test("identifiers match existing holdings by providerSymbol, case-insensitively", () => {
    const statement = parsedOk(
      [
        HEADER,
        "01/02/2026;Cripto;Bitcoin;Compra;0,01;500;;",
        "01/02/2026;Plan de pensiones;N5572-myinvestor;Compra;9;119;;",
        "01/02/2026;Fondo;IE00BYX5NX33;Compra;1;100;;",
      ].join("\n"),
    );

    const buckets = resolveStatementImportBuckets(statement, [
      { assetId: "a_btc", name: "Bitcoin", operations: [], providerSymbol: "bitcoin" },
      {
        assetId: "a_plan",
        name: "Mi plan",
        operations: [],
        providerSymbol: "N5572-myinvestor",
      },
    ]);

    expect(
      buckets.map((bucket) => ({ bucket: bucket.bucket, isin: bucket.isin })),
    ).toEqual([
      { bucket: "matched", isin: "Bitcoin" },
      { bucket: "matched", isin: "N5572-myinvestor" },
      { bucket: "new", isin: "IE00BYX5NX33" },
    ]);
  });
});
