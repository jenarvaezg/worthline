import { describe, expect, test } from "vitest";

import {
  chooseFundHolding,
  defaultFundSelection,
  type FundSelectionState,
  isFundChoicePending,
  pluralize,
  summarizeImportSelection,
} from "./import-statement-summary";

function fund(overrides: Partial<FundSelectionState> = {}): FundSelectionState {
  return {
    amountMinor: 100_00,
    bucket: "matched",
    executedCount: 2,
    included: true,
    isin: "ES00WL000009",
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

  test("an identifier awaiting a holding choice counts even though it cannot be included", () => {
    const summary = summarizeImportSelection([
      fund({ isin: "A", choicePending: true, included: false }),
      fund({ isin: "B", choicePending: false }),
      // "new" has no claimants to choose between — the flag is meaningless there.
      fund({ isin: "C", bucket: "new", choicePending: true, included: false }),
    ]);

    expect(summary.pendingChoiceCount).toBe(1);
    expect(summary.fundCount).toBe(1);
  });

  test("empty selection summarizes to all-zero", () => {
    expect(summarizeImportSelection([])).toEqual({
      amountMinor: 0,
      excludedCount: 0,
      executedRows: 0,
      fundCount: 0,
      matchedCount: 0,
      newCount: 0,
      pendingChoiceCount: 0,
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

describe("per-fund selection rules (#1366)", () => {
  test("a single-claimant match starts included, aimed at that claimant", () => {
    expect(
      defaultFundSelection({
        ambiguous: false,
        assetId: "asset_only",
        bucket: "matched",
        replacesOpening: true,
      }),
    ).toEqual({
      assetId: "asset_only",
      included: true,
      replaceOpening: true,
      symbolEmpty: false,
    });
  });

  test("an ambiguous identifier starts unchosen AND excluded — never pre-aimed", () => {
    const flags = defaultFundSelection({
      ambiguous: true,
      assetId: "asset_best_ranked",
      bucket: "matched",
      replacesOpening: true,
    });

    expect(flags.assetId).toBe("");
    expect(flags.included).toBe(false);
  });

  test("naming a holding includes the fund and re-reads its opening default", () => {
    const start = defaultFundSelection({
      ambiguous: true,
      assetId: "asset_a",
      bucket: "matched",
      replacesOpening: true,
    });

    const chosen = chooseFundHolding(start, {
      assetId: "asset_b",
      replacesOpening: false,
    });

    expect(chosen).toEqual({
      assetId: "asset_b",
      included: true,
      // Read from the newly chosen claimant, not carried over from asset_a.
      replaceOpening: false,
      symbolEmpty: false,
    });
    expect(start.assetId).toBe(""); // never mutated
  });

  test("clearing the choice takes the fund back out instead of leaving it armed", () => {
    const chosen = chooseFundHolding(
      { assetId: "asset_b", included: true, replaceOpening: true, symbolEmpty: false },
      { assetId: "", replacesOpening: false },
    );

    expect(chosen.included).toBe(false);
    expect(chosen.assetId).toBe("");
  });

  test("the choice is pending only for an ambiguous match with nothing named", () => {
    const pending = { assetId: "" };
    const named = { assetId: "asset_a" };

    expect(isFundChoicePending({ ambiguous: true, bucket: "matched" }, pending)).toBe(
      true,
    );
    expect(isFundChoicePending({ ambiguous: true, bucket: "matched" }, named)).toBe(
      false,
    );
    expect(isFundChoicePending({ ambiguous: false, bucket: "matched" }, pending)).toBe(
      false,
    );
    expect(isFundChoicePending({ bucket: "new" }, pending)).toBe(false);
  });
});
