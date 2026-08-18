import type { FireCapitalSplit } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  fireCapitalSplitRows,
  sellableFundedPercent,
  shouldShowCapitalSplit,
} from "./fire-capital-split-view";

function makeSplit(overrides: {
  sellable?: Partial<FireCapitalSplit["sellable"]>;
  immobilized?: Partial<FireCapitalSplit["immobilized"]>;
}): FireCapitalSplit {
  return {
    immobilized: {
      absorbedDebtMinor: 0,
      amountMinor: 0,
      debtMinor: 0,
      grossMinor: 0,
      reservedMinor: 0,
      tiers: [],
      ...overrides.immobilized,
    },
    sellable: {
      absorbedDebtMinor: 0,
      amountMinor: 0,
      debtMinor: 0,
      grossMinor: 0,
      reservedMinor: 0,
      tiers: [],
      ...overrides.sellable,
    },
  };
}

describe("shouldShowCapitalSplit", () => {
  test("hides the breakdown when nothing is immobilized", () => {
    expect(
      shouldShowCapitalSplit(
        makeSplit({ sellable: { amountMinor: 100, grossMinor: 100, tiers: ["market"] } }),
      ),
    ).toBe(false);
  });

  test("shows it as soon as there is brick or a collection in the pool", () => {
    expect(
      shouldShowCapitalSplit(
        makeSplit({ immobilized: { grossMinor: 1, tiers: ["housing"] } }),
      ),
    ).toBe(true);
  });
});

describe("fireCapitalSplitRows", () => {
  test("names each side by the rungs it is made of", () => {
    const rows = fireCapitalSplitRows(
      makeSplit({
        immobilized: {
          amountMinor: 301_372,
          grossMinor: 370_000,
          tiers: ["illiquid", "housing"],
        },
        sellable: {
          amountMinor: 153_926,
          grossMinor: 153_926,
          tiers: ["market", "term-locked"],
        },
      }),
    );

    expect(rows.map((row) => row.label)).toEqual(["vendible", "inmovilizado"]);
    expect(rows[0]?.gloss).toBe("Mercado + A plazo");
    expect(rows[1]?.gloss).toBe("Ilíquido + Vivienda");
  });

  test("says what was netted out of each side", () => {
    const rows = fireCapitalSplitRows(
      makeSplit({
        immobilized: {
          amountMinor: 301_372,
          debtMinor: 68_628,
          grossMinor: 370_000,
          tiers: ["housing"],
        },
        sellable: {
          amountMinor: 113_926,
          grossMinor: 153_926,
          reservedMinor: 40_000,
          tiers: ["market"],
        },
      }),
    );

    expect(rows[0]?.gloss).toBe("Mercado − lo reservado para objetivos");
    expect(rows[1]?.gloss).toBe("Vivienda − su deuda");
  });

  test("names the debt a side had to absorb from the other one", () => {
    const rows = fireCapitalSplitRows(
      makeSplit({
        immobilized: {
          absorbedDebtMinor: 0,
          amountMinor: 0,
          debtMinor: 80_000,
          grossMinor: 50_000,
          tiers: ["housing"],
        },
        sellable: {
          absorbedDebtMinor: 30_000,
          amountMinor: 70_000,
          grossMinor: 100_000,
          tiers: ["market"],
        },
      }),
    );

    // 1.000,00 € of market printing 700,00 € has to say where the 300 € went.
    expect(rows[0]?.gloss).toBe("Mercado − la deuda que su garantía no cubre");
    expect(rows[1]?.gloss).toBe("Vivienda − su deuda");
  });

  test("handles an empty side without inventing a rung", () => {
    const rows = fireCapitalSplitRows(
      makeSplit({ immobilized: { grossMinor: 100, tiers: ["housing"] } }),
    );

    expect(rows[0]?.gloss).toBe("sin activos");
  });
});

describe("sellableFundedPercent", () => {
  test("measures only the sellable side against the FIRE number", () => {
    const split = makeSplit({
      immobilized: { amountMinor: 315_744_00, grossMinor: 384_372_00 },
      sellable: { amountMinor: 153_927_00, grossMinor: 153_927_00 },
    });

    expect(sellableFundedPercent(split, 685_714_29)).toBeCloseTo(22.45, 2);
  });

  test("is null without a FIRE number to divide by", () => {
    expect(sellableFundedPercent(makeSplit({}), 0)).toBeNull();
  });
});
