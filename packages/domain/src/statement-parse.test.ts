import { describe, expect, test } from "vitest";

import { multiplyToMinor } from "./decimal";
import { parseStatement } from "./statement-parse";

/**
 * A representative MyInvestor orders export (ADR 0018), in the documented shape:
 * `;`-delimited, `dd/mm/yyyy` dates, amounts with `.` decimals and a ` EUR`
 * suffix, units with `,` decimals. Ten rows: eight `Finalizada` (load as buys),
 * one `En curso` and one `Rechazada` (skipped, not errors). The real sample
 * carries personal data and is kept out of the public repo (per repo policy), so
 * this fixture reproduces its structure with the values called out in the PRD.
 */
const SAMPLE = [
  "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
  "01/10/2025;IE00BYX5NX33;100 EUR;7,226;Finalizada",
  "01/11/2025;IE00BYX5NX33;100 EUR;7,180;Finalizada",
  "01/12/2025;IE00BYX5NX33;100 EUR;7,050;Finalizada",
  "01/01/2026;IE00BYX5NX33;559 EUR;39,120;Finalizada",
  "01/02/2026;IE00BYX5NX33;100 EUR;6,900;Finalizada",
  "01/03/2026;IE00BYX5NX33;100 EUR;6,800;Finalizada",
  "01/04/2026;IE00BYX5NX33;100 EUR;6,700;Finalizada",
  "01/05/2026;IE00BYX5NX33;1418.15 EUR;95,400;Finalizada",
  "01/06/2026;IE00BYX5NX33;100 EUR;6,500;En curso",
  "11/06/2026;IE00BYX5NX33;100 EUR;6,400;Rechazada",
].join("\n");

function parsedOk(rawText: string) {
  const result = parseStatement(rawText, "myinvestor");
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${result.errors.join(" | ")}`);
  }
  return result.value;
}

describe("parseStatement — MyInvestor (ADR 0018, S1)", () => {
  test("the sample loads its 8 Finalizada rows as buys and skips the other 2", () => {
    const { rows, skipped } = parsedOk(SAMPLE);

    expect(rows).toHaveLength(8);
    expect(skipped).toHaveLength(2);
    // Every loaded row is a buy in EUR with no fees (S1 has no sells).
    for (const row of rows) {
      expect(row.kind).toBe("buy");
      expect(row.currency).toBe("EUR");
      expect(row.feesMinor).toBe(0);
    }
  });

  test("dd/mm/yyyy dates become ISO date keys, in file order", () => {
    const { rows } = parsedOk(SAMPLE);

    expect(rows.map((r) => r.dateKey)).toEqual([
      "2025-10-01",
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]);
  });

  test("units take the `,`-decimal `Nº de participaciones`", () => {
    const { rows } = parsedOk(SAMPLE);

    expect(rows[0]!.units).toBe("7.226");
    expect(rows[3]!.units).toBe("39.12");
    expect(rows[7]!.units).toBe("95.4");
  });

  test("pricePerUnit = Importe ÷ units, precise enough that cost reconstructs to the amount", () => {
    const { rows } = parsedOk(SAMPLE);

    // 100 EUR ÷ 7.226 units, folded back to minor units, equals 100.00 EUR.
    expect(multiplyToMinor(rows[0]!.units, rows[0]!.pricePerUnit)).toBe(100_00);
    // The larger amounts reconstruct too (no decimal drift): 559 and 1418.15.
    expect(multiplyToMinor(rows[3]!.units, rows[3]!.pricePerUnit)).toBe(559_00);
    expect(multiplyToMinor(rows[7]!.units, rows[7]!.pricePerUnit)).toBe(1418_15);
  });

  test("the file's ISIN is extracted", () => {
    expect(parsedOk(SAMPLE).isin).toBe("IE00BYX5NX33");
  });

  test("the ` EUR` suffix is stripped from the amount", () => {
    const oneRow = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "15/01/2024;IE00BYX5NX33;250 EUR;10;Finalizada",
    ].join("\n");

    const { rows } = parsedOk(oneRow);
    expect(rows).toHaveLength(1);
    expect(multiplyToMinor(rows[0]!.units, rows[0]!.pricePerUnit)).toBe(250_00);
    expect(rows[0]!.pricePerUnit).toBe("25");
  });

  test("a negative amount marks the row as a sell, stored with absolute price and units", () => {
    const sell = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "15/01/2024;IE00BYX5NX33;-250 EUR;10;Finalizada",
    ].join("\n");

    const { rows } = parsedOk(sell);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("sell");
    // The model keeps units/price positive; the kind carries the direction.
    expect(rows[0]!.units).toBe("10");
    expect(rows[0]!.pricePerUnit).toBe("25");
    expect(multiplyToMinor(rows[0]!.units, rows[0]!.pricePerUnit)).toBe(250_00);
  });

  test("negative units (`,`-decimal) also mark a sell, stored absolute", () => {
    const sell = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "15/01/2024;IE00BYX5NX33;250 EUR;-7,226;Finalizada",
    ].join("\n");

    const { rows } = parsedOk(sell);
    expect(rows[0]!.kind).toBe("sell");
    expect(rows[0]!.units).toBe("7.226");
  });

  test("a malformed Finalizada row still aborts the whole load even alongside a sell", () => {
    const mixed = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "15/01/2024;IE00BYX5NX33;-250 EUR;10;Finalizada",
      "32/13/2025;IE00BYX5NX33;100 EUR;7,000;Finalizada",
    ].join("\n");

    expect(parseStatement(mixed, "myinvestor").ok).toBe(false);
  });

  test("a malformed Finalizada row aborts the whole load (ADR 0010) and parses nothing", () => {
    const bad = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/10/2025;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "32/13/2025;IE00BYX5NX33;100 EUR;7,000;Finalizada",
    ].join("\n");

    const result = parseStatement(bad, "myinvestor");
    expect(result.ok).toBe(false);
  });

  test("a file carrying more than one distinct ISIN parses and exposes its ISINs", () => {
    // ADR 0055: portfolio-level routing handles mixed files after parsing.
    const mixed = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/10/2025;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "01/11/2025;LU0000000000;100 EUR;7,180;Finalizada",
    ].join("\n");

    const result = parseStatement(mixed, "myinvestor");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.isin).toBeNull();
    expect(result.value.isins).toEqual(["IE00BYX5NX33", "LU0000000000"]);
    expect(result.value.rows.map((row) => row.isin)).toEqual([
      "IE00BYX5NX33",
      "LU0000000000",
    ]);
  });

  test("a missing required column is an error, not a silent empty parse", () => {
    const noEstado = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones",
      "01/10/2025;IE00BYX5NX33;100 EUR;7,226",
    ].join("\n");

    expect(parseStatement(noEstado, "myinvestor").ok).toBe(false);
  });
});

/**
 * The FULL orders export (ADR 0018, amended 2026-07-07): same columns plus
 * `Tipo de operación`, which is authoritative for direction. The real reembolso
 * sample that disproved the sign rule arrives with POSITIVE amount and units —
 * only the tipo distinguishes it from a buy.
 */
const FULL_HEADER =
  "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado;Tipo de operación";

describe("parseStatement — MyInvestor full export (`Tipo de operación`)", () => {
  test("the tipo column is authoritative: positive-signed reembolsos/ventas/bajas load as sells", () => {
    const { rows, directionResolved } = parsedOk(
      [
        FULL_HEADER,
        "18/06/2026;LU0208853274;1943.08 EUR;62;Finalizada;Reembolso Fondos de Inversión",
        "26/05/2026;LU1935059029;7536.7 EUR;364,092;Finalizada;Suscripción por Traspaso Interno",
        "24/05/2026;LU1670707527;7403.99 EUR;337;Finalizada;Reembolso por Traspaso Interno",
        "23/06/2026;JE00B8DFY052;703.9 EUR;33;Finalizada;Compra rv contado de WT PHYSICAL GOLD",
        "25/06/2026;ES0165265002;119.38 EUR;9,044;Finalizada;Aportación",
        "20/06/2026;IE00B42W4L06;500 EUR;10;Finalizada;Baja switch",
        "21/06/2026;IE00B67T5G21;500 EUR;10;Finalizada;Alta switch",
        "22/06/2026;IE00BDRK7L36;250 EUR;5;Finalizada;Venta rv contado de VANECK URANIUM",
      ].join("\n"),
    );

    expect(directionResolved).toBe(true);
    expect(rows.map((row) => row.kind)).toEqual([
      "sell",
      "buy",
      "sell",
      "buy",
      "buy",
      "sell",
      "buy",
      "sell",
    ]);
    // Sells still store absolute magnitudes — the kind carries the direction.
    expect(rows[0]!.units).toBe("62");
  });

  test("an unrecognized tipo aborts the whole load instead of guessing a direction", () => {
    const result = parseStatement(
      [
        FULL_HEADER,
        "18/06/2026;LU0208853274;1943.08 EUR;62;Finalizada;Reembolso Fondos de Inversión",
        "19/06/2026;LU0208853274;100 EUR;3;Finalizada;Canje de participaciones",
      ].join("\n"),
      "myinvestor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors[0]).toContain("Canje de participaciones");
  });

  test("an empty tipo cell on a Finalizada row aborts the load (no silent sign guess)", () => {
    // With the tipo column present the file reports directionResolved: true and
    // shows NO warning — so a per-row sign fallback here would silently
    // re-introduce the mis-import this feature exists to prevent.
    const result = parseStatement(
      [
        FULL_HEADER,
        "18/06/2026;LU0208853274;1943.08 EUR;62;Finalizada;Reembolso Fondos de Inversión",
        "19/06/2026;LU0208853274;100 EUR;3;Finalizada;",
      ].join("\n"),
      "myinvestor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors[0]).toContain("sin tipo de operación");
    expect(result.errors[0]).toContain("LU0208853274");
  });

  test("the reduced export (no tipo column) parses but reports directionResolved: false", () => {
    const { directionResolved, rows } = parsedOk(SAMPLE);

    expect(directionResolved).toBe(false);
    expect(rows).toHaveLength(8);
  });
});
