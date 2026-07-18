import { describe, expect, test } from "vitest";

import {
  discardRow,
  type MatchCandidateRow,
  type MatchPortfolioHolding,
  matchHoldings,
  type RowMatch,
  reassignToCandidate,
  reassignToNew,
} from "./holding-matcher";

/**
 * Multi-key editable holding matcher (PRD #1103 S1).
 *
 * Behaviour, not shape: each test drives a real reconcile question — does an ISIN
 * resolve on its own? does a name coincidence stay weak and correctable? can the
 * user reassign without ever silently rewriting the wrong holding?
 */

const holding = (
  over: Partial<MatchPortfolioHolding> & { holdingId: string },
): MatchPortfolioHolding => ({
  name: "Holding",
  ...over,
});

const row = (
  over: Partial<MatchCandidateRow> & { rowId: string },
): MatchCandidateRow => ({
  ...over,
});

const only = (matches: RowMatch[]): RowMatch => {
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

describe("matchHoldings — strong key (ISIN)", () => {
  test("an exact ISIN resolves to update on its own, strong confidence", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Amundi World", isin: "IE00B4L5Y983" }),
    ];
    const match = only(
      matchHoldings([row({ rowId: "r1", isin: "IE00B4L5Y983" })], portfolio),
    );

    expect(match).toMatchObject({
      decision: "update",
      target: "h1",
      confidence: "strong",
      key: "isin",
    });
    expect(match.candidates).toEqual([
      { holdingId: "h1", name: "Amundi World", key: "isin", confidence: "strong" },
    ]);
    expect(match.possibleDuplicate).toBeUndefined();
  });

  test("ISIN matching is case-insensitive and whitespace-tolerant", () => {
    const portfolio = [holding({ holdingId: "h1", isin: "IE00B4L5Y983" })];
    const match = only(
      matchHoldings([row({ rowId: "r1", isin: "  ie00b4l5y983 " })], portfolio),
    );
    expect(match.decision).toBe("update");
    expect(match.target).toBe("h1");
  });

  test("a provider symbol (CoinGecko id) matches case-insensitively (#695)", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Bitcoin", providerSymbol: "bitcoin" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", providerSymbol: "Bitcoin", name: "BTC" })],
        portfolio,
      ),
    );
    expect(match).toMatchObject({
      decision: "update",
      target: "h1",
      key: "provider_symbol",
    });
  });

  test("ISIN wins over provider symbol when both are present", () => {
    const portfolio = [
      holding({ holdingId: "byIsin", isin: "IE00B4L5Y983" }),
      holding({ holdingId: "bySymbol", providerSymbol: "FN0001" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", isin: "IE00B4L5Y983", providerSymbol: "FN0001" })],
        portfolio,
      ),
    );
    expect(match.target).toBe("byIsin");
    expect(match.key).toBe("isin");
  });

  test("an ISIN the portfolio does not hold falls through to create", () => {
    const portfolio = [holding({ holdingId: "h1", isin: "IE00B4L5Y983" })];
    const match = only(
      matchHoldings([row({ rowId: "r1", isin: "LU0000000000" })], portfolio),
    );
    expect(match).toMatchObject({ decision: "create", confidence: "none", key: "none" });
    expect(match.candidates).toEqual([]);
  });
});

describe("matchHoldings — weak key (name + instrument)", () => {
  test("an exact normalized name+instrument proposes update at weak confidence", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Cuenta Naranja", instrument: "current_account" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", name: "  cuenta  naranja ", instrument: "current_account" })],
        portfolio,
      ),
    );
    expect(match).toMatchObject({
      decision: "update",
      target: "h1",
      confidence: "weak",
      key: "name",
    });
  });

  test("diacritics are folded so 'Fundación' matches 'fundacion'", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Fundación Ahorro", instrument: "fund" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", name: "fundacion ahorro", instrument: "fund" })],
        portfolio,
      ),
    );
    expect(match.decision).toBe("update");
    expect(match.target).toBe("h1");
  });

  test("a name with no portfolio counterpart is a clean create", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Something else", instrument: "fund" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", name: "Brand New Fund", instrument: "fund" })],
        portfolio,
      ),
    );
    expect(match).toMatchObject({ decision: "create", confidence: "none" });
    expect(match.possibleDuplicate).toBeUndefined();
  });

  test("multiple same-name holdings are all offered, best-first, default to the first", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Depósito", instrument: "term_deposit" }),
      holding({ holdingId: "h2", name: "Depósito", instrument: "term_deposit" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", name: "Deposito", instrument: "term_deposit" })],
        portfolio,
      ),
    );
    expect(match.target).toBe("h1");
    expect(match.candidates.map((candidate) => candidate.holdingId)).toEqual([
      "h1",
      "h2",
    ]);
  });

  test("name matches without a declared instrument on either side (name-only weak)", () => {
    const portfolio = [holding({ holdingId: "h1", name: "Mi Piso" })];
    const match = only(matchHoldings([row({ rowId: "r1", name: "mi piso" })], portfolio));
    expect(match).toMatchObject({ decision: "update", target: "h1", confidence: "weak" });
  });
});

describe("matchHoldings — hostile: never silently rewrite the wrong holding", () => {
  test("a same-name row of a DIFFERENT instrument does not match — it creates", () => {
    // "Naranja" is both an investment fund the user holds and the name they typed
    // for a brand-new current account. A loose name match would rewrite the fund's
    // positions. The instrument guard must keep them apart.
    const portfolio = [
      holding({ holdingId: "fund", name: "Naranja", instrument: "fund" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", name: "Naranja", instrument: "current_account" })],
        portfolio,
      ),
    );

    expect(match.decision).toBe("create");
    expect(match.target).toBeUndefined();
    expect(match.candidates).toEqual([]);
    // Nothing points at the fund — its positions are safe.
    expect(match.candidates.some((candidate) => candidate.holdingId === "fund")).toBe(
      false,
    );
  });

  test("a coincidental same-instrument name never resolves as strong, so the preview flags it", () => {
    // Two genuinely different funds that happen to share a display name. The match
    // is only ever `weak`, so the surface shows it as editable and never applies a
    // silent authoritative overwrite.
    const portfolio = [
      holding({ holdingId: "existing", name: "Renta Fija", instrument: "fund" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", name: "Renta Fija", instrument: "fund" })],
        portfolio,
      ),
    );

    expect(match.confidence).toBe("weak");
    expect(match.confidence).not.toBe("strong");
  });

  test("a fuzzy/substring name is NOT a match (only exact normalized equality)", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Amundi MSCI World", instrument: "fund" }),
    ];
    const match = only(
      matchHoldings(
        [row({ rowId: "r1", name: "Amundi MSCI Europe", instrument: "fund" })],
        portfolio,
      ),
    );
    expect(match.decision).toBe("create");
    expect(match.candidates).toEqual([]);
  });

  test("the wrong weak default is correctable: reassign to create yields a clean, untargeted row", () => {
    const portfolio = [
      holding({ holdingId: "wrong", name: "Ahorro", instrument: "fund" }),
    ];
    const proposed = only(
      matchHoldings(
        [row({ rowId: "r1", name: "Ahorro", instrument: "fund" })],
        portfolio,
      ),
    );
    expect(proposed.target).toBe("wrong"); // weak default proposed the existing holding

    const corrected = reassignToNew(proposed);
    expect(corrected.decision).toBe("create");
    expect(corrected.target).toBeUndefined(); // the wrong holding is no longer touched
    expect(corrected.possibleDuplicate).toEqual({
      holdingId: "wrong",
      name: "Ahorro",
      key: "name",
      confidence: "weak",
    });
  });
});

describe("matchHoldings — duplicate warning (S2 underpin)", () => {
  test("a create with a surviving weak candidate carries possibleDuplicate", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "Cuenta Nómina", instrument: "current_account" }),
    ];
    const proposed = only(
      matchHoldings(
        [row({ rowId: "r1", name: "Cuenta Nomina", instrument: "current_account" })],
        portfolio,
      ),
    );
    const asCreate = reassignToNew(proposed);
    expect(asCreate.decision).toBe("create");
    expect(asCreate.possibleDuplicate?.holdingId).toBe("h1");
  });

  test("a create with no candidate has no duplicate warning (clean alta)", () => {
    const proposed = only(matchHoldings([row({ rowId: "r1", name: "Totally New" })], []));
    expect(proposed.decision).toBe("create");
    expect(proposed.possibleDuplicate).toBeUndefined();
  });

  test("creating over an exact-ISIN hit still warns (strong duplicate, not just weak)", () => {
    const portfolio = [
      holding({ holdingId: "h1", name: "World ETF", isin: "IE00B4L5Y983" }),
    ];
    const proposed = only(
      matchHoldings([row({ rowId: "r1", isin: "IE00B4L5Y983" })], portfolio),
    );
    expect(proposed.decision).toBe("update"); // strong default
    const asCreate = reassignToNew(proposed);
    expect(asCreate.decision).toBe("create");
    expect(asCreate.possibleDuplicate).toEqual({
      holdingId: "h1",
      name: "World ETF",
      key: "isin",
      confidence: "strong",
    });
  });
});

describe("reassignment API — pure, immutable", () => {
  const portfolio = [
    holding({ holdingId: "h1", name: "Fondo A", instrument: "fund" }),
    holding({ holdingId: "h2", name: "Fondo A", instrument: "fund" }),
  ];
  const base = () =>
    only(
      matchHoldings(
        [row({ rowId: "r1", name: "Fondo A", instrument: "fund" })],
        portfolio,
      ),
    );

  test("reassignToCandidate switches the update target and adopts its confidence", () => {
    const original = base();
    const reassigned = reassignToCandidate(original, "h2");
    expect(reassigned).toMatchObject({
      decision: "update",
      target: "h2",
      confidence: "weak",
      key: "name",
    });
    expect(original.target).toBe("h1"); // input untouched
  });

  test("reassignToCandidate rejects a holding that was never a candidate", () => {
    expect(() => reassignToCandidate(base(), "ghost")).toThrow(/not a candidate/);
  });

  test("new → match: a created row can be pointed at a candidate", () => {
    const created = reassignToNew(base());
    expect(created.decision).toBe("create");
    const rematched = reassignToCandidate(created, "h1");
    expect(rematched).toMatchObject({ decision: "update", target: "h1" });
    expect(rematched.possibleDuplicate).toBeUndefined();
  });

  test("discardRow leaves the portfolio untouched and clears the target", () => {
    const discarded = discardRow(base());
    expect(discarded).toMatchObject({
      decision: "leave",
      confidence: "none",
      key: "none",
    });
    expect(discarded.target).toBeUndefined();
    expect(discarded.candidates).toHaveLength(2); // still recoverable
  });

  test("a strong match survives reassignment round-trips without mutation", () => {
    const strong = only(
      matchHoldings(
        [row({ rowId: "r1", isin: "IE00B4L5Y983" })],
        [holding({ holdingId: "h1", isin: "IE00B4L5Y983" })],
      ),
    );
    const roundTrip = reassignToCandidate(reassignToNew(strong), "h1");
    expect(roundTrip).toMatchObject({
      decision: "update",
      target: "h1",
      confidence: "strong",
      key: "isin",
    });
    expect(strong.decision).toBe("update"); // original intact
  });
});

describe("matchHoldings — batch", () => {
  test("mixed batch: each row resolves independently and order is preserved", () => {
    const portfolio = [
      holding({
        holdingId: "hIsin",
        isin: "IE00B4L5Y983",
        name: "World ETF",
        instrument: "etf",
      }),
      holding({
        holdingId: "hName",
        name: "Cuenta Ahorro",
        instrument: "current_account",
      }),
    ];
    const matches = matchHoldings(
      [
        row({ rowId: "strong", isin: "IE00B4L5Y983" }),
        row({ rowId: "weak", name: "Cuenta Ahorro", instrument: "current_account" }),
        row({ rowId: "new", name: "Plan Nuevo", instrument: "pension_plan" }),
      ],
      portfolio,
    );

    expect(matches.map((match) => match.rowId)).toEqual(["strong", "weak", "new"]);
    expect(matches[0]).toMatchObject({
      decision: "update",
      confidence: "strong",
      target: "hIsin",
    });
    expect(matches[1]).toMatchObject({
      decision: "update",
      confidence: "weak",
      target: "hName",
    });
    expect(matches[2]).toMatchObject({ decision: "create", confidence: "none" });
  });

  test("empty rows and empty portfolio are both handled", () => {
    expect(matchHoldings([], [holding({ holdingId: "h1" })])).toEqual([]);
    const match = only(matchHoldings([row({ rowId: "r1", name: "X" })], []));
    expect(match.decision).toBe("create");
  });
});
