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
    expect(resolveStatementIsinGuard("IE00BYX5NX33", "LU0000000000")).toEqual({
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
        "IE00BYX5NX33",
      ),
    ).toEqual({ status: "match" });
  });

  test("any row with a different ISIN rejects the per-holding upload", () => {
    expect(
      resolvePerHoldingStatementIsinGuard(
        statementWithIsins(["IE00BYX5NX33", "LU0000000000"]),
        "IE00BYX5NX33",
      ),
    ).toEqual({
      fileIsins: ["IE00BYX5NX33", "LU0000000000"],
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
});
