import { describe, expect, test } from "vitest";

import { resolveStatementIsinGuard } from "./statement-isin";

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
