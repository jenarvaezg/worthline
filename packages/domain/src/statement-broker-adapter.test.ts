import { describe, expect, test } from "vitest";

import {
  getStatementBrokerAdapter,
  isStatementBroker,
  type StatementBrokerAdapter,
} from "./statement-broker-adapter";
import { myinvestorAdapter } from "./statement-myinvestor-adapter";
import { parseStatement, parseStatementWithAdapter } from "./statement-parse";

/**
 * Tests for the broker-adapter seam (issue #480). The MyInvestor end-to-end
 * sample lives in statement-parse.test.ts (kept as the behavior anchor); here we
 * pin the three new seams: the registry, the generic dispatcher driven by a FAKE
 * adapter (so the core's ISIN guard / all-or-nothing is tested independent of any
 * real broker), and the MyInvestor adapter's column + row parsing in isolation.
 */

describe("statement broker registry", () => {
  test("recognizes a configured broker id", () => {
    expect(isStatementBroker("myinvestor")).toBe(true);
    expect(getStatementBrokerAdapter("myinvestor")).toBe(myinvestorAdapter);
  });

  test("rejects an unconfigured broker id", () => {
    expect(isStatementBroker("revolut")).toBe(false);
    expect(getStatementBrokerAdapter("revolut")).toBeUndefined();
  });

  test("parseStatement fails with the Spanish message for an unknown broker", () => {
    // Cast past the static type to exercise the runtime dispatcher guard.
    const result = parseStatement("anything", "revolut" as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toContain("No hay un lector configurado");
    expect(result.errors[0]).toContain("revolut");
  });
});

/**
 * A minimal fake broker: tab-delimited, two columns [tag, isin]. `tag` drives the
 * outcome so one fixture can exercise every branch of the core loop:
 *   - "row"  → a loaded buy
 *   - "skip" → a skipped row
 *   - "err"  → a row-level error
 * `tag` is first so a missing `isin` is a trailing cell (the core trims each line,
 * which would collapse a leading empty cell). The ISIN is reported on every outcome
 * so the core's cross-row single-ISIN guard is what's under test, not the adapter.
 */
const fakeAdapter: StatementBrokerAdapter<{ isin: number; tag: number }> = {
  splitRow: (line) => line.split("\t"),
  resolveColumns: (header) => {
    if (header[0] !== "tag" || header[1] !== "isin") {
      return { ok: false, errors: ["cabecera falsa inválida"] };
    }
    return { ok: true, columns: { isin: 1, tag: 0 } };
  },
  parseRow: ({ cells, columns, lineNumber }) => {
    const isin = (cells[columns.isin] ?? "").trim() || null;
    const tag = (cells[columns.tag] ?? "").trim();
    if (tag === "skip") {
      return {
        isin,
        outcome: { kind: "skipped", skipped: { dateKey: null, estado: "skip" } },
      };
    }
    if (tag === "err") {
      return { isin, outcome: { kind: "error", error: `fila ${lineNumber} mala` } };
    }
    return {
      isin,
      outcome: {
        kind: "row",
        row: {
          currency: "EUR",
          dateKey: "2024-01-01",
          feesMinor: 0,
          kind: "buy",
          pricePerUnit: "1",
          units: "1",
        },
      },
    };
  },
};

describe("parseStatementWithAdapter — generic core (fake adapter)", () => {
  test("an empty file is rejected before the adapter is consulted", () => {
    const result = parseStatementWithAdapter("", fakeAdapter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toBe("El archivo está vacío.");
  });

  test("a header the adapter rejects surfaces the adapter's errors", () => {
    const result = parseStatementWithAdapter("wrong\theader", fakeAdapter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toBe("cabecera falsa inválida");
  });

  test("aggregates loaded rows and skipped rows, extracting the single ISIN", () => {
    const file = ["tag\tisin", "row\tAAA", "skip\tAAA", "row\tAAA"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.isin).toBe("AAA");
  });

  test("a row-level error aborts the whole load (all-or-nothing)", () => {
    const file = ["tag\tisin", "row\tAAA", "err\tAAA"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toContain("fila 3 mala");
  });

  test("more than one distinct ISIN is rejected by the core, not the adapter", () => {
    const file = ["tag\tisin", "row\tAAA", "row\tBBB"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toContain("varios ISIN");
    expect(result.errors[0]).toContain("AAA");
    expect(result.errors[0]).toContain("BBB");
  });

  test("the ISIN guard counts skipped rows, not just loaded ones", () => {
    // The skipped row carries the second ISIN — the guard must still trip.
    const file = ["tag\tisin", "row\tAAA", "skip\tBBB"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toContain("varios ISIN");
  });

  test("the ISIN guard counts errored rows too", () => {
    // The errored row carries the second ISIN — the guard must still trip (the
    // ISIN is reported alongside an error outcome, not swallowed by it).
    const file = ["tag\tisin", "row\tAAA", "err\tBBB"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes("varios ISIN"))).toBe(true);
  });

  test("no ISIN at all yields a null isin, not an error", () => {
    // `tag` only, no trailing isin cell — the core trims each line, so a leading
    // empty cell would be collapsed; a trailing-absent cell is the honest "no ISIN".
    const file = ["tag\tisin", "row", "row"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.isin).toBeNull();
    expect(result.value.rows).toHaveLength(2);
  });
});

describe("myinvestorAdapter — column resolution", () => {
  test("resolves the documented columns case-insensitively", () => {
    const header = myinvestorAdapter.splitRow(
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
    );
    const resolved = myinvestorAdapter.resolveColumns(header);
    expect(resolved.ok).toBe(true);
  });

  test("a missing required column is a MyInvestor-format error", () => {
    const header = myinvestorAdapter.splitRow(
      "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones",
    );
    const resolved = myinvestorAdapter.resolveColumns(header);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected failure");
    expect(resolved.errors[0]).toContain("formato de MyInvestor");
    expect(resolved.errors[0]).toContain("Estado");
  });
});

describe("myinvestorAdapter — row parsing", () => {
  const COLUMNS = (() => {
    const resolved = myinvestorAdapter.resolveColumns(
      myinvestorAdapter.splitRow(
        "Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado",
      ),
    );
    if (!resolved.ok) throw new Error("fixture header must resolve");
    return resolved.columns;
  })();

  function parse(line: string, lineNumber = 2) {
    return myinvestorAdapter.parseRow({
      cells: myinvestorAdapter.splitRow(line),
      columns: COLUMNS,
      lineNumber,
    });
  }

  test("a Finalizada buy loads with ISO date, EUR-stripped amount, and reads its ISIN", () => {
    const result = parse("15/01/2024;IE00BYX5NX33;250 EUR;10;Finalizada");
    expect(result.isin).toBe("IE00BYX5NX33");
    expect(result.outcome.kind).toBe("row");
    if (result.outcome.kind !== "row") throw new Error("expected row");
    expect(result.outcome.row.kind).toBe("buy");
    expect(result.outcome.row.dateKey).toBe("2024-01-15");
    expect(result.outcome.row.units).toBe("10");
    expect(result.outcome.row.pricePerUnit).toBe("25");
  });

  test("a non-Finalizada row is skipped (not an error) and still reports its ISIN", () => {
    const result = parse("15/01/2024;IE00BYX5NX33;250 EUR;10;En curso");
    expect(result.isin).toBe("IE00BYX5NX33");
    expect(result.outcome.kind).toBe("skipped");
    if (result.outcome.kind !== "skipped") throw new Error("expected skipped");
    expect(result.outcome.skipped.estado).toBe("En curso");
  });

  test("a negative amount marks a sell, stored absolute", () => {
    const result = parse("15/01/2024;IE00BYX5NX33;-250 EUR;10;Finalizada");
    if (result.outcome.kind !== "row") throw new Error("expected row");
    expect(result.outcome.row.kind).toBe("sell");
    expect(result.outcome.row.units).toBe("10");
    expect(result.outcome.row.pricePerUnit).toBe("25");
  });

  test("negative units also mark a sell, stored absolute", () => {
    const result = parse("15/01/2024;IE00BYX5NX33;250 EUR;-7,226;Finalizada");
    if (result.outcome.kind !== "row") throw new Error("expected row");
    expect(result.outcome.row.kind).toBe("sell");
    expect(result.outcome.row.units).toBe("7.226");
  });

  test("a malformed Finalizada row is a row-level error citing the line and Finalizada", () => {
    const result = parse("32/13/2024;IE00BYX5NX33;100 EUR;7,000;Finalizada", 5);
    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind !== "error") throw new Error("expected error");
    expect(result.outcome.error).toContain("fila 5");
    expect(result.outcome.error).toContain("Finalizada");
  });
});
