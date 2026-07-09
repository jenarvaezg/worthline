import { describe, expect, test } from "vitest";

import {
  type FundSelectionState,
  pluralize,
  summarizeImportSelection,
} from "./import-statement-summary";

function fund(overrides: Partial<FundSelectionState> = {}): FundSelectionState {
  return {
    amountMinor: 100_00,
    bucket: "matched",
    executedCount: 2,
    included: true,
    isin: "ES00WL000001",
    skippedCount: 0,
    symbolEmpty: false,
    ...overrides,
  };
}

describe("summarizeImportSelection", () => {
  test("counts only included funds", () => {
    const summary = summarizeImportSelection([
      fund({ isin: "A", included: true }),
      fund({ isin: "B", included: false }),
    ]);

    expect(summary.fundCount).toBe(1);
    expect(summary.excludedCount).toBe(1);
  });

  test("splits included funds by bucket", () => {
    const summary = summarizeImportSelection([
      fund({ isin: "A", bucket: "matched" }),
      fund({ isin: "B", bucket: "new" }),
      fund({ isin: "C", bucket: "new" }),
    ]);

    expect(summary.matchedCount).toBe(1);
    expect(summary.newCount).toBe(2);
  });

  test("sums executed rows and amount across included funds only", () => {
    const summary = summarizeImportSelection([
      fund({ isin: "A", executedCount: 3, amountMinor: 1_000 }),
      fund({ isin: "B", executedCount: 5, amountMinor: 2_000, included: false }),
    ]);

    expect(summary.executedRows).toBe(3);
    expect(summary.amountMinor).toBe(1_000);
  });

  test("flags included new funds with an empty symbol as unresolved", () => {
    const summary = summarizeImportSelection([
      fund({ isin: "A", bucket: "new", symbolEmpty: true }),
      fund({ isin: "B", bucket: "new", symbolEmpty: false }),
      fund({ isin: "C", bucket: "matched", symbolEmpty: true }), // matched: never counted
    ]);

    expect(summary.unresolvedSymbolCount).toBe(1);
  });

  test("a symbol-empty new fund that is excluded does not count as unresolved", () => {
    const summary = summarizeImportSelection([
      fund({ isin: "A", bucket: "new", symbolEmpty: true, included: false }),
    ]);

    expect(summary.unresolvedSymbolCount).toBe(0);
    expect(summary.fundCount).toBe(0);
  });

  test("empty selection summarizes to all-zero", () => {
    expect(summarizeImportSelection([])).toEqual({
      amountMinor: 0,
      excludedCount: 0,
      executedRows: 0,
      fundCount: 0,
      matchedCount: 0,
      newCount: 0,
      unresolvedSymbolCount: 0,
    });
  });
});

describe("pluralize", () => {
  test("uses the singular form for exactly one", () => {
    expect(pluralize(1, "fondo", "fondos")).toBe("1 fondo");
  });

  test("uses the plural form for zero and for more than one", () => {
    expect(pluralize(0, "fondo", "fondos")).toBe("0 fondos");
    expect(pluralize(2, "fondo", "fondos")).toBe("2 fondos");
  });
});
