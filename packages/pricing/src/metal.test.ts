/**
 * Metal-value resolver (PRD #160 / #163, ADR 0017).
 *
 * Maps a coin's composition text + weight + metal spot (EUR/oz) to a melt value.
 * Pure given its inputs — the spot fetch (Stooq) and FX (ECB) live in the sync
 * layer. Composition text comes from Numista in Spanish (lang=es).
 */
import { describe, expect, test } from "vitest";

import { metalValueMinor, parseComposition } from "./metal";

describe("parseComposition — Numista composition text → metal + fineness", () => {
  test("reads a millesimal fineness", () => {
    expect(parseComposition("Plata 999")).toEqual({
      metal: "silver",
      finenessMillis: 999,
    });
  });

  test("reads a decimal/parenthesised fineness", () => {
    expect(parseComposition("Oro (.900)")).toEqual({
      metal: "gold",
      finenessMillis: 900,
    });
    expect(parseComposition("Plata (.925)")).toEqual({
      metal: "silver",
      finenessMillis: 925,
    });
  });

  test("recognises platinum and palladium without confusing them with silver", () => {
    expect(parseComposition("Platino 950")).toEqual({
      metal: "platinum",
      finenessMillis: 950,
    });
    expect(parseComposition("Paladio 999")).toEqual({
      metal: "palladium",
      finenessMillis: 999,
    });
  });

  test("a base-metal alloy resolves to no precious metal", () => {
    expect(parseComposition("Cuproníquel")).toEqual({
      metal: null,
      finenessMillis: null,
    });
    expect(parseComposition("Bronce")).toEqual({ metal: null, finenessMillis: null });
  });

  test("a named metal with no fineness leaves fineness unknown", () => {
    expect(parseComposition("Oro")).toEqual({ metal: "gold", finenessMillis: null });
  });

  test("null/empty composition resolves to nothing", () => {
    expect(parseComposition(null)).toEqual({ metal: null, finenessMillis: null });
  });
});

describe("metalValueMinor — composition × weight × spot (EUR/oz)", () => {
  const OZT = 31.1034768; // grams per troy ounce

  test("one troy ounce of pure metal at €30/oz is €30", () => {
    expect(
      metalValueMinor({
        metal: "silver",
        finenessMillis: 1000,
        weightGrams: OZT,
        quantity: 1,
        spotPerOzEur: 30,
      }),
    ).toBe(3000);
  });

  test("scales by fineness and quantity", () => {
    expect(
      metalValueMinor({
        metal: "silver",
        finenessMillis: 500,
        weightGrams: OZT,
        quantity: 2,
        spotPerOzEur: 30,
      }),
    ).toBe(3000); // half pure × 2 coins = 1 oz equivalent
  });

  test("a real Silver Eagle (31.103 g, .999) at €28/oz", () => {
    expect(
      metalValueMinor({
        metal: "silver",
        finenessMillis: 999,
        weightGrams: 31.103,
        quantity: 1,
        spotPerOzEur: 28,
      }),
    ).toBe(2797);
  });

  test("no metal, no spot, no weight, or unknown fineness all yield null (no melt value)", () => {
    const base = {
      metal: "silver" as const,
      finenessMillis: 999,
      weightGrams: 31.1,
      quantity: 1,
      spotPerOzEur: 28,
    };
    expect(metalValueMinor({ ...base, metal: null })).toBeNull();
    expect(metalValueMinor({ ...base, spotPerOzEur: null })).toBeNull();
    expect(metalValueMinor({ ...base, weightGrams: null })).toBeNull();
    expect(metalValueMinor({ ...base, finenessMillis: null })).toBeNull();
  });
});
