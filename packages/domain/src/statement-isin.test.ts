import { describe, expect, test } from "vitest";

import {
  resolvePerHoldingStatementIsinGuard,
  resolveStatementIsinGuard,
} from "./statement-isin";
import type { ParsedStatement } from "./statement-parse";

/**
 * ISIN guard (ADR 0018, S4 / #178): a statement must not be grafted onto the
 * wrong holding. The file's ISIN is compared to the asset's recorded ISIN —
 * match proceeds, mismatch blocks, an empty asset is backfilled.
 */
describe("resolveStatementIsinGuard (ADR 0018, S4)", () => {
  test("equal ISINs match", () => {
    expect(resolveStatementIsinGuard("IE00BYX5NX33", "IE00BYX5NX33")).toEqual({
      status: "match",
    });
  });

  test("different ISINs mismatch (block)", () => {
    expect(resolveStatementIsinGuard("IE00BYX5NX33", "LU0000000009")).toEqual({
      status: "mismatch",
    });
  });

  test("an asset with no ISIN backfills from the file", () => {
    expect(resolveStatementIsinGuard("IE00BYX5NX33", null)).toEqual({
      status: "backfill",
      isin: "IE00BYX5NX33",
    });
    expect(resolveStatementIsinGuard("IE00BYX5NX33", undefined)).toEqual({
      status: "backfill",
      isin: "IE00BYX5NX33",
    });
  });

  test("a file with no ISIN is absent — nothing to guard, proceed without backfill", () => {
    expect(resolveStatementIsinGuard(null, "IE00BYX5NX33")).toEqual({ status: "absent" });
    expect(resolveStatementIsinGuard(null, null)).toEqual({ status: "absent" });
  });

  test("comparison ignores case and surrounding whitespace", () => {
    expect(resolveStatementIsinGuard("ie00byx5nx33", " IE00BYX5NX33 ")).toEqual({
      status: "match",
    });
  });

  test("a non-ISIN in the file column never backfills — the guard proceeds without writing (#1453)", () => {
    // A DGS code (or any garbage) in the isin column carries no ISIN identity:
    // writing it would store the profile key under a value the catalog never
    // registers, so the holding turns «sin clasificar» silently.
    expect(resolveStatementIsinGuard("N5394", null)).toEqual({ status: "absent" });
  });
});

function statementWithIsins(isins: Array<string | null>): ParsedStatement {
  return {
    directionResolved: true,
    isin: isins.length === 1 ? (isins[0] ?? null) : null,
    isins: isins.filter((isin): isin is string => Boolean(isin)),
    rows: isins.map((isin, index) => ({
      currency: "EUR",
      dateKey: `2026-01-${String(index + 1).padStart(2, "0")}`,
      feesMinor: 0,
      isin,
      kind: "buy",
      pricePerUnit: "10",
      units: "1",
    })),
    skipped: [],
  };
}

describe("resolvePerHoldingStatementIsinGuard (ADR 0055 one-fund case)", () => {
  test("all file rows matching the holding ISIN proceed", () => {
    expect(
      resolvePerHoldingStatementIsinGuard(
        statementWithIsins(["IE00BYX5NX33", "IE00BYX5NX33"]),
        { kind: "isin", value: "IE00BYX5NX33" },
      ),
    ).toEqual({ status: "match" });
  });

  test("any row with a different ISIN rejects the per-holding upload", () => {
    expect(
      resolvePerHoldingStatementIsinGuard(
        statementWithIsins(["IE00BYX5NX33", "LU0000000009"]),
        { kind: "isin", value: "IE00BYX5NX33" },
      ),
    ).toEqual({
      fileIsins: ["IE00BYX5NX33", "LU0000000009"],
      status: "mismatch",
    });
  });

  test("an empty holding ISIN backfills when the file carries exactly one ISIN", () => {
    expect(
      resolvePerHoldingStatementIsinGuard(
        statementWithIsins(["ie00byx5nx33", " IE00BYX5NX33 "]),
        null,
      ),
    ).toEqual({
      isin: "IE00BYX5NX33",
      status: "backfill",
    });
  });

  test("a single non-ISIN in the file column never backfills an empty holding (#1453)", () => {
    expect(
      resolvePerHoldingStatementIsinGuard(statementWithIsins(["N5394"]), null),
    ).toEqual({ status: "absent" });
  });

  // #1743: el hueco lo ocupa el identificador, sea de la clase que sea. Rellenar
  // aquí borraría el código DGS del plan con el ISIN de un papel que no es suyo.
  test("a holding identified by its DGS code is never backfilled from a file ISIN", () => {
    expect(
      resolvePerHoldingStatementIsinGuard(statementWithIsins(["IE00BYX5NX33"]), {
        kind: "dgs",
        value: "N5394",
      }),
    ).toEqual({ fileIsins: ["IE00BYX5NX33"], status: "mismatch" });
  });

  test("a preserved import (kind null) also occupies the hole", () => {
    expect(
      resolvePerHoldingStatementIsinGuard(statementWithIsins(["IE00BYX5NX33"]), {
        kind: null,
        value: "algo-que-nadie-supo-leer",
      }),
    ).toEqual({ fileIsins: ["IE00BYX5NX33"], status: "mismatch" });
  });
});
