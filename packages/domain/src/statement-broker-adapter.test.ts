import { describe, expect, test } from "vitest";

import {
  getStatementBrokerAdapter,
  isStatementBroker,
  type StatementBrokerAdapter,
} from "./statement-broker-adapter";
import { plantillaAdapter } from "./statement-plantilla-adapter";
import { parseStatement, parseStatementWithAdapter } from "./statement-parse";

/**
 * Tests for the broker-adapter seam (issue #480). End-to-end plantilla parsing
 * lives in statement-plantilla.test.ts; here we pin the registry and the
 * generic dispatcher driven by a FAKE adapter (so the core's row attribution /
 * all-or-nothing is tested independent of any real broker).
 */

describe("statement broker registry", () => {
  test("recognizes a configured broker id", () => {
    expect(isStatementBroker("plantilla")).toBe(true);
    expect(getStatementBrokerAdapter("plantilla")).toBe(plantillaAdapter);
  });

  test("rejects an unconfigured broker id", () => {
    expect(isStatementBroker("myinvestor")).toBe(false);
    expect(getStatementBrokerAdapter("myinvestor")).toBeUndefined();
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

  test("more than one distinct ISIN is accepted and exposed by the core", () => {
    const file = ["tag\tisin", "row\tAAA", "row\tBBB"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.isin).toBeNull();
    expect(result.value.isins).toEqual(["AAA", "BBB"]);
    expect(result.value.rows.map((row) => row.isin)).toEqual(["AAA", "BBB"]);
  });

  test("distinct ISIN extraction counts skipped rows, not just loaded ones", () => {
    // The skipped row carries the second ISIN; routing still needs to see it.
    const file = ["tag\tisin", "row\tAAA", "skip\tBBB"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.isins).toEqual(["AAA", "BBB"]);
    expect(result.value.skipped.map((row) => row.isin)).toEqual(["BBB"]);
  });

  test("row-level errors still abort the whole load", () => {
    // The errored row carries a second ISIN, but the parse failure is the row error
    // itself; mixed-ISIN handling moved to the routing layer in ADR 0055.
    const file = ["tag\tisin", "row\tAAA", "err\tBBB"].join("\n");
    const result = parseStatementWithAdapter(file, fakeAdapter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toContain("fila 3 mala");
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
