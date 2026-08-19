import { describe, expect, test } from "vitest";
import {
  formatFineFirePercent,
  formatFirePercent,
  formatMultiplierPercent,
  formatRatePercent,
  formatRatePoints,
} from "./fire-percent";

describe("formatFirePercent", () => {
  test("keeps one decimal in es-ES", () => {
    expect(formatFirePercent(68.45)).toBe("68,5 %");
    expect(formatFirePercent(100)).toBe("100,0 %");
  });
});

describe("formatRatePercent", () => {
  test("reads a decimal rate as a percentage", () => {
    expect(formatRatePercent(0.042162)).toBe("4,2 %");
    expect(formatRatePercent(-0.012)).toBe("-1,2 %");
  });
});

describe("formatFineFirePercent", () => {
  test("keeps two decimals, so the mix rows visibly add up", () => {
    expect(formatFineFirePercent(0.2793)).toBe("27,93 %");
    expect(formatFineFirePercent(1)).toBe("100,00 %");
  });
});

describe("formatMultiplierPercent", () => {
  test("a definition carries no decimal it does not need", () => {
    expect(formatMultiplierPercent(0.7)).toBe("70 %");
    expect(formatMultiplierPercent(1.5)).toBe("150 %");
    expect(formatMultiplierPercent(0.725)).toBe("72,5 %");
  });
});

describe("formatRatePoints", () => {
  test("says points, so it cannot be read as a share of the base", () => {
    expect(formatRatePoints(0.015)).toBe("1,5 puntos");
    expect(formatRatePoints(0.01)).toBe("1 punto");
  });
});
