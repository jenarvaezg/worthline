import { describe, expect, it } from "vitest";

import { createFigureMap, hasCommonFactor } from "./figure-map";

const SECRET = "test-secret-not-the-real-one";

describe("createFigureMap().amount", () => {
  it("is stable: the same amount always gives the same fake, whatever its literal", () => {
    const first = createFigureMap(SECRET);
    const second = createFigureMap(SECRET);
    expect(first.amount("208.0000")).toBe(first.amount("208"));
    expect(first.amount("208")).toBe(second.amount("208"));
  });

  it("keeps zero and the sign", () => {
    const figures = createFigureMap(SECRET);
    expect(figures.amount("0.00")).toBe("0");
    expect(Number(figures.amount("-40"))).toBeLessThan(0);
  });

  it("stays in the same order of magnitude, with cents that never look round", () => {
    const figures = createFigureMap(SECRET);
    for (const real of ["35", "85", "110", "240", "410", "1300", "17320", "0.19"]) {
      const fake = figures.amount(real);
      expect(fake).toMatch(/^\d+\.\d?[1-46-9]$/);
      expect(fake).not.toBe(real);
      expect(Number(fake) / Number(real)).toBeGreaterThan(0.5);
      expect(Number(fake) / Number(real)).toBeLessThan(2.5);
    }
  });

  it("never gives two amounts the same fake, nor a forbidden one", () => {
    const forbidden = new Set<string>();
    const probe = createFigureMap(SECRET);
    forbidden.add(probe.amount("110"));
    const figures = createFigureMap(SECRET, { amounts: forbidden });
    expect(forbidden.has(figures.amount("110"))).toBe(false);
    const fakes = new Set<string>();
    for (let i = 1; i <= 500; i++) fakes.add(figures.amount(String(i)));
    expect(fakes.size).toBe(500);
  });

  it("keeps no common factor between amounts", () => {
    const figures = createFigureMap(SECRET);
    for (const real of ["35.7", "64.9", "85.3", "110.2", "240.6", "270.4"])
      figures.amount(real);
    expect(hasCommonFactor(figures.pairs())).toBe(false);
  });
});

describe("createFigureMap().quantity", () => {
  it("rounds to the decimals asked and never drops to zero", () => {
    const figures = createFigureMap(SECRET);
    expect(figures.quantity("6.183", 3)).toMatch(/^\d+(\.\d{1,3})?$/);
    expect(figures.quantity("1", 0)).toMatch(/^[1-9]\d*$/);
    expect(figures.quantity("0.001", 3)).not.toBe("0");
    expect(figures.quantity("0", 3)).toBe("0");
  });
});

describe("hasCommonFactor", () => {
  it("spots fakes that are the reals times one factor", () => {
    const pairs = ["35", "85", "240", "310.5"].map((real) => ({
      real,
      fake: String(Number(real) * 1.37),
    }));
    expect(hasCommonFactor(pairs)).toBe(true);
  });

  it("counts a real amount once, however often it repeats", () => {
    const repeated = Array.from({ length: 20 }, () => ({ real: "240", fake: "317.86" }));
    const others = [
      { real: "45", fake: "33.62" },
      { real: "310.5", fake: "466.21" },
    ];
    expect(hasCommonFactor([...repeated, ...others])).toBe(false);
  });

  it("does not judge with fewer than three pairs", () => {
    expect(hasCommonFactor([{ real: "1", fake: "2" }])).toBe(false);
  });
});
