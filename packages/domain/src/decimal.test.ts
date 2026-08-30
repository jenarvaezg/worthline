import { describe, expect, test } from "vitest";

import {
  addUnits,
  averageUnitCost,
  compareUnits,
  formatPrice,
  formatUnits,
  multiplyToMinor,
  proportionMinor,
  scaleMinorByWeight,
  splitMinorByWeights,
  subtractUnits,
} from "./decimal";
import { allocateByBps } from "./money";

describe("decimal units arithmetic", () => {
  test("adds and subtracts fractional units without float drift", () => {
    expect(addUnits("0.1", "0.2")).toBe("0.3");
    expect(subtractUnits("1.5", "0.7")).toBe("0.8");
    expect(addUnits("0.00000001", "0.00000002")).toBe("0.00000003");
  });

  test("compares units as -1, 0, 1", () => {
    expect(compareUnits("1.5", "2")).toBe(-1);
    expect(compareUnits("2", "2")).toBe(0);
    expect(compareUnits("3", "2")).toBe(1);
  });
});

describe("decimal to integer minor units", () => {
  test("multiplies units by price into minor units, rounding half up", () => {
    expect(multiplyToMinor("10", "12.34")).toBe(12_340); // 123.40 EUR
    expect(multiplyToMinor("1.5", "100")).toBe(15_000); // 150.00 EUR
    expect(multiplyToMinor("0.123456", "100")).toBe(1_235); // 12.3456 EUR -> 12.35
  });

  test("removes a proportional slice of a minor total, half up, guarding zero whole", () => {
    expect(proportionMinor(10_000, "1", "4")).toBe(2_500); // 100.00 * 1/4
    expect(proportionMinor(10_000, "1", "3")).toBe(3_333); // 33.333 -> 33.33
    expect(proportionMinor(5_000, "1", "0")).toBe(0);
  });

  test("expresses cost basis per unit as a currency decimal", () => {
    expect(averageUnitCost(30_000, "2")).toBe("150"); // 300.00 / 2
    expect(averageUnitCost(10_000, "3")).toBe("33.3333"); // 100 / 3 at 4dp
    expect(averageUnitCost(0, "0")).toBe("0");
  });
});

describe("reading voices", () => {
  test("formatUnits uses es-ES separators at six decimals", () => {
    expect(formatUnits("3.409963")).toBe("3,409963");
    expect(formatUnits("6")).toBe("6");
  });

  test("formatPrice uses es-ES separators at eight decimals, with no padding (#1467)", () => {
    expect(formatPrice("52.09166666666666667")).toBe("52,09166667");
    expect(formatPrice("65.045")).toBe("65,045");
    expect(formatPrice("6")).toBe("6");
  });

  test("a malformed figure is shown raw rather than as NaN", () => {
    expect(formatUnits("nope")).toBe("nope");
    expect(formatPrice("nope")).toBe("nope");
  });
});

describe("exact .5 rounding boundary", () => {
  test("multiplyToMinor rounds exact .5 up (not down or even)", () => {
    // 0.5 * 1 * 100 = 50 exactly — half-up must give 50
    // But the interesting case is when the minor result sits on .5:
    // 1 * 0.005 * 100 = 0.5 → round half-up → 1
    expect(multiplyToMinor("1", "0.005")).toBe(1);
    // 3 * 0.005 * 100 = 1.5 → round half-up → 2
    expect(multiplyToMinor("3", "0.005")).toBe(2);
    // 1 * 0.015 * 100 = 1.5 → round half-up → 2
    expect(multiplyToMinor("1", "0.015")).toBe(2);
  });

  test("proportionMinor rounds exact .5 up", () => {
    // 5 * 1 / 2 = 2.5 → round half-up → 3
    expect(proportionMinor(5, "1", "2")).toBe(3);
    // 15 * 1 / 2 = 7.5 → round half-up → 8
    expect(proportionMinor(15, "1", "2")).toBe(8);
    // 1 * 1 / 2 = 0.5 → round half-up → 1
    expect(proportionMinor(1, "1", "2")).toBe(1);
  });
});

describe("splitMinorByWeights (#1610)", () => {
  test("reparte el total exacto: ni inventa un céntimo ni lo pierde", () => {
    // 60/40 sucio sobre un importe que no cae en céntimos exactos: cada parte
    // trunca y el céntimo sobrante va al resto mayor (0,60005 > 0,39995).
    const parts = splitMinorByWeights(100_001, [
      { key: "bond", weight: "0.39995" },
      { key: "equity", weight: "0.60005" },
    ]);

    expect(Object.fromEntries(parts)).toEqual({ bond: 39_995, equity: 60_006 });
    expect(parts.reduce((sum, [, amountMinor]) => sum + amountMinor, 0)).toBe(100_001);
  });

  test("un empate de restos lo rompe la clave, no el orden de entrada", () => {
    const ordered = splitMinorByWeights(101, [
      { key: "alfa", weight: "0.5" },
      { key: "beta", weight: "0.5" },
    ]);
    const reversed = splitMinorByWeights(101, [
      { key: "beta", weight: "0.5" },
      { key: "alfa", weight: "0.5" },
    ]);

    expect(Object.fromEntries(ordered)).toEqual({ alfa: 51, beta: 50 });
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(ordered));
  });

  test("devuelve todos los destinos, también los que se quedan a cero", () => {
    // Un cubo que redondea a nada sigue siendo un cubo por el que preguntaron:
    // la clase que hoy no vale nada se emite MARCADA, nunca se omite.
    const parts = splitMinorByWeights(0, [
      { key: "bond", weight: "0.4" },
      { key: "equity", weight: "0.6" },
    ]);

    expect(parts).toEqual([
      ["bond", 0],
      ["equity", 0],
    ]);
  });
});

describe("scaleMinorByWeight (#1610)", () => {
  test("redondea como allocateByBps allí donde ambos saben decir la misma fracción", () => {
    const cases: Array<[number, string, number]> = [
      [1, "0.5", 5_000],
      [1, "0.4999", 4_999],
      [1, "0.5001", 5_001],
      [-1, "0.5", 5_000],
      [-3, "0.5", 5_000],
      [-1, "0.5001", 5_001],
      [123_456, "1", 10_000],
      [-123_456, "1", 10_000],
      [123_456, "0", 0],
    ];

    for (const [amountMinor, weight, bps] of cases) {
      expect(scaleMinorByWeight(amountMinor, weight)).toBe(
        allocateByBps(amountMinor, bps),
      );
    }
  });

  test("el medio céntimo sube hacia +∞, nunca alejándose del cero", () => {
    // Escalar la compra (flujo negativo) no puede empujarla más lejos del cero.
    expect(scaleMinorByWeight(-3, "0.5")).toBe(-1);
    expect(scaleMinorByWeight(3, "0.5")).toBe(2);
  });

  test("lee pesos más finos que un punto básico, que es lo que bps no puede", () => {
    expect(scaleMinorByWeight(100_000, "0.60005")).toBe(60_005);
    expect(allocateByBps(100_000, 6_001)).toBe(60_010);
  });
});
