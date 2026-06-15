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

  test("a malformed Finalizada row aborts the whole load (ADR 0010) and parses nothing", () => {
    const bad = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/10/2025;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "32/13/2025;IE00BYX5NX33;100 EUR;7,000;Finalizada",
    ].join("\n");

    const result = parseStatement(bad, "myinvestor");
    expect(result.ok).toBe(false);
  });

  test("a file carrying more than one distinct ISIN is rejected as malformed", () => {
    // A statement is per-ISIN (ADR 0018); a mixed file is a wrong-file slip.
    const mixed = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      "01/10/2025;IE00BYX5NX33;100 EUR;7,226;Finalizada",
      "01/11/2025;LU0000000000;100 EUR;7,180;Finalizada",
    ].join("\n");

    expect(parseStatement(mixed, "myinvestor").ok).toBe(false);
  });

  test("a missing required column is an error, not a silent empty parse", () => {
    const noEstado = [
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones",
      "01/10/2025;IE00BYX5NX33;100 EUR;7,226",
    ].join("\n");

    expect(parseStatement(noEstado, "myinvestor").ok).toBe(false);
  });
});
