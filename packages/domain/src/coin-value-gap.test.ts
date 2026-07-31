import { describe, expect, test } from "vitest";

import {
  type CoinValueGapInput,
  coinValueGap,
  summarizeCoinValueGaps,
} from "./coin-value-gap";

/** A coin that IS valued (silver, weight + fineness + a resolved melt value). */
function coin(overrides: Partial<CoinValueGapInput> = {}): CoinValueGapInput {
  return {
    finenessMillis: 999,
    grade: "XF",
    issueId: 42,
    metal: "silver",
    metalValueMinor: 3200,
    numismaticValueMinor: null,
    purchasePriceMinor: null,
    quantity: 1,
    weightGrams: 31.1,
    ...overrides,
  };
}

describe("coinValueGap", () => {
  test("a valued coin has no gap, whichever rung produced its value", () => {
    expect(coinValueGap(coin())).toBeNull();
    expect(
      coinValueGap(coin({ metalValueMinor: null, numismaticValueMinor: 5000 })),
    ).toBeNull();
    expect(
      coinValueGap(
        coin({
          metal: null,
          finenessMillis: null,
          weightGrams: null,
          metalValueMinor: null,
          purchasePriceMinor: 1200,
        }),
      ),
    ).toBeNull();
  });

  test("a precious-metal coin missing the fineness names the fineness", () => {
    expect(coinValueGap(coin({ finenessMillis: null, metalValueMinor: null }))).toBe(
      "fineness",
    );
  });

  test("a precious-metal coin missing the weight names the weight", () => {
    expect(coinValueGap(coin({ weightGrams: null, metalValueMinor: null }))).toBe(
      "weight",
    );
  });

  test("a precious-metal coin with every input but no melt value blames the spot", () => {
    // Weight + fineness + metal are all known, so nothing the user records is
    // missing: the metal quote itself never resolved (the #1354 outage shape).
    expect(coinValueGap(coin({ metalValueMinor: null }))).toBe("spot");
  });

  test("the metal branch outranks the numismatic one: the melt floor is the stronger rescue", () => {
    expect(
      coinValueGap(coin({ finenessMillis: null, grade: "", metalValueMinor: null })),
    ).toBe("fineness");
  });

  test("a base-metal coin with no grade names the grade", () => {
    expect(
      coinValueGap(
        coin({
          grade: "  ",
          metal: null,
          finenessMillis: null,
          weightGrams: null,
          metalValueMinor: null,
        }),
      ),
    ).toBe("grade");
  });

  test("a base-metal coin with a grade but no issue names the issue", () => {
    expect(
      coinValueGap(
        coin({
          issueId: null,
          metal: null,
          finenessMillis: null,
          weightGrams: null,
          metalValueMinor: null,
        }),
      ),
    ).toBe("issue");
  });

  test("a graded, issued coin Numista does not estimate names the estimate", () => {
    expect(
      coinValueGap(
        coin({
          metal: null,
          finenessMillis: null,
          weightGrams: null,
          metalValueMinor: null,
        }),
      ),
    ).toBe("estimate");
  });

  test("a melt value that rounds to nothing falls through to the numismatic gap", () => {
    // 0 is not a value (`coinValue` only lets a POSITIVE candidate win), so the
    // coin is unvalued — but the metal inputs are all present, so the gap is not
    // there.
    expect(coinValueGap(coin({ grade: "", metalValueMinor: 0 }))).toBe("grade");
  });
});

describe("summarizeCoinValueGaps", () => {
  test("counts each coin under its single primary gap, most common first", () => {
    const coins = [
      coin({ grade: "", metal: null, finenessMillis: null, metalValueMinor: null }),
      coin({ grade: "", metal: null, finenessMillis: null, metalValueMinor: null }),
      coin({ grade: "", metal: null, finenessMillis: null, metalValueMinor: null }),
      coin({ finenessMillis: null, metalValueMinor: null }),
    ];

    expect(summarizeCoinValueGaps(coins)).toBe(
      "3 sin grado en Numista, 1 sin la ley del metal en el catálogo",
    );
  });

  test("counts coins, not lines: a ×N line contributes N to its gap", () => {
    expect(
      summarizeCoinValueGaps([
        coin({ grade: "", metal: null, metalValueMinor: null, quantity: 4 }),
        coin({ finenessMillis: null, metalValueMinor: null, quantity: 2 }),
      ]),
    ).toBe("4 sin grado en Numista, 2 sin la ley del metal en el catálogo");
  });

  test("ignores valued coins, so a fully valued collection summarizes to nothing", () => {
    expect(summarizeCoinValueGaps([coin(), coin()])).toBeNull();
    expect(summarizeCoinValueGaps([])).toBeNull();
  });

  test("breaks count ties on the canonical gap order, never on input order", () => {
    const finenessFirst = summarizeCoinValueGaps([
      coin({ finenessMillis: null, metalValueMinor: null }),
      coin({ grade: "", metal: null, finenessMillis: null, metalValueMinor: null }),
    ]);
    const gradeFirst = summarizeCoinValueGaps([
      coin({ grade: "", metal: null, finenessMillis: null, metalValueMinor: null }),
      coin({ finenessMillis: null, metalValueMinor: null }),
    ]);

    expect(finenessFirst).toBe(gradeFirst);
    expect(finenessFirst).toBe(
      "1 sin la ley del metal en el catálogo, 1 sin grado en Numista",
    );
  });
});
