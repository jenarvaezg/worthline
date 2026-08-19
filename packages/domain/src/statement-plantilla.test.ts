import { describe, expect, test } from "vitest";

import { multiplyToMinor } from "./decimal";
import { isIsinShaped } from "./matching-keys";
import {
  findStatementTypeConflict,
  groupStatementRowsByIsin,
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
    expect(rows.every((row) => row.occurredAt === undefined)).toBe(true);
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

  test("a type worthline models elsewhere names its own door instead of only the six (#1405)", () => {
    // Jorge's real file: 271 rows declaring `Hipoteca`, converted from his bank's
    // cuadro de amortización. The rejection is right — a mortgage is a plan that
    // generates its curve, not 270 buys and sells — but the old message listed the
    // six accepted types and read as «worthline no sabe de hipotecas».
    const result = parseStatement(
      [
        HEADER,
        "19/05/2004;Hipoteca;HIP-PLASENCIA-2004;Compra;1;173153,18;;Hipoteca",
      ].join("\n"),
      "plantilla",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    const [error] = result.errors;
    expect(error).toContain("HIP-PLASENCIA-2004");
    expect(error).toContain("sí modela las deudas");
    expect(error).toContain("/patrimonio/anadir");
    // Re-pointed by #1406: the row's own history has a reader now, on this very
    // screen, so the signpost names it instead of twenty-three manual forms.
    expect(error).toContain("«Cuadro de amortización»");
    // Still all-or-nothing: nothing loads, the row has to go.
    expect(error).toContain("no se ha cargado nada");
  });

  test("each known-but-elsewhere family points at its own drawer, accent/case-insensitive", () => {
    for (const [tipo, expected] of [
      ["Préstamo", "cajón «Deuda»"],
      ["TARJETA", "cajón «Deuda»"],
      ["Vivienda", "cajón «Inmueble»"],
      ["inmueble", "cajón «Inmueble»"],
      ["Efectivo", "cajón «Dinero»"],
      ["Cuenta corriente", "cajón «Dinero»"],
    ] as const) {
      const result = parseStatement(
        [HEADER, `01/02/2026;${tipo};X-1;Compra;1;100;;`].join("\n"),
        "plantilla",
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.errors[0]).toContain(expected);
    }
  });

  test("a type worthline models nowhere still gets the list of the six", () => {
    const result = parseStatement(
      [HEADER, "01/02/2026;Sello de correos;X-1;Compra;1;100;;"].join("\n"),
      "plantilla",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors[0]).toContain("no reconozco");
    expect(result.errors[0]).toContain("Plan de pensiones");
    expect(result.errors[0]).not.toContain("/patrimonio/anadir");
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

describe("parseStatement — plantilla, la columna Divisa (#1401)", () => {
  test("a row states the currency its Importe is in", () => {
    const { rows } = parsedOk(
      [
        `${HEADER};Divisa`,
        // The father's real MyInvestor purchase: 2,04 US$ over 0,255 participaciones.
        "23/01/2026;Fondo;IE00BDZVHT63;Compra;0,255;2,04;;Fidelity Pacific ex-Japan;USD",
      ].join("\n"),
    );

    expect(rows[0]!.currency).toBe("USD");
    // The price stays the NAV the file states — 8,00 US$ — and the CONVERSION
    // happens at the write, with the ECB rate of the execution date.
    expect(rows[0]!.pricePerUnit).toBe("8");
  });

  test("no column at all is EUR, exactly as before", () => {
    const { rows } = parsedOk(
      [HEADER, "01/02/2026;Fondo;IE00BYX5NX33;Compra;7,226;100;;Fidelity"].join("\n"),
    );

    expect(rows[0]!.currency).toBe("EUR");
  });

  test("an empty Divisa cell is EUR too", () => {
    const { rows } = parsedOk(
      [
        `${HEADER};Divisa`,
        "01/02/2026;Fondo;IE00BYX5NX33;Compra;7,226;100;;Fidelity;",
      ].join("\n"),
    );

    expect(rows[0]!.currency).toBe("EUR");
  });

  test("a currency this app cannot capture aborts the load, naming the row", () => {
    const result = parseStatement(
      [
        `${HEADER};Divisa`,
        "01/02/2026;Fondo;IE00BYX5NX33;Compra;7,226;100;;Fidelity;JPY",
      ].join("\n"),
      "plantilla",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("divisa");
    expect(result.errors[0]).toContain("JPY");
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

describe("parseStatement — plantilla, derived price scale (#1467)", () => {
  test("a purchase of 6 units for 312,55 € writes the price at 8 decimals", () => {
    const { rows } = parsedOk(
      [HEADER, "19/08/2026;Fondo;IE00BYX5NX33;Compra;6;312,55;;Jorge"].join("\n"),
    );

    expect(rows[0]!.pricePerUnit).toBe("52.09166667");
    expect(multiplyToMinor(rows[0]!.units, rows[0]!.pricePerUnit)).toBe(312_55);
  });

  test("a periodic division does not write more decimals than the canonical 8", () => {
    const { rows } = parsedOk(
      [HEADER, "19/08/2026;Fondo;IE00BYX5NX33;Compra;3;1;;"].join("\n"),
    );

    expect(rows[0]!.pricePerUnit).toBe("0.33333333");
    expect(rows[0]!.pricePerUnit.split(".")[1]?.length).toBeLessThanOrEqual(8);
  });
});
