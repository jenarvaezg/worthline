import Big from "big.js";
import { describe, expect, test } from "vitest";

import {
  cadenceOrDefault,
  interpolateOrStep,
  sampleDateForCadence,
} from "./valuation-cadence";

/**
 * The shared step-vs-interpolate primitive for modeled holdings (ADR 0031). It
 * is unit-agnostic — it works on big.js values and the caller rounds at the
 * edge — so these assertions read the exact big.js result via `.toString()`.
 */
describe("interpolateOrStep", () => {
  const lower = new Big(1_000_00);
  const upper = new Big(0);

  test("step returns the lower value regardless of where the target falls", () => {
    expect(
      interpolateOrStep({
        lower,
        upper,
        span: 30,
        offset: 0,
        cadence: "step",
      }).toString(),
    ).toBe("100000");
    expect(
      interpolateOrStep({
        lower,
        upper,
        span: 30,
        offset: 15,
        cadence: "step",
      }).toString(),
    ).toBe("100000");
    expect(
      interpolateOrStep({
        lower,
        upper,
        span: 30,
        offset: 29,
        cadence: "step",
      }).toString(),
    ).toBe("100000");
  });

  test("interpolated draws a linear line across the span", () => {
    // halfway: 100000 + (0 − 100000) × 15/30 = 50000
    expect(
      interpolateOrStep({
        lower,
        upper,
        span: 30,
        offset: 15,
        cadence: "interpolated",
      }).toString(),
    ).toBe("50000");
  });

  test("interpolated at offset 0 equals lower; at offset == span equals upper", () => {
    expect(
      interpolateOrStep({
        lower,
        upper,
        span: 30,
        offset: 0,
        cadence: "interpolated",
      }).toString(),
    ).toBe("100000");
    expect(
      interpolateOrStep({
        lower,
        upper,
        span: 30,
        offset: 30,
        cadence: "interpolated",
      }).toString(),
    ).toBe("0");
  });

  test("zero-length span returns lower for both cadences (no fraction to compute)", () => {
    expect(
      interpolateOrStep({ lower, upper, span: 0, offset: 0, cadence: "step" }).toString(),
    ).toBe("100000");
    expect(
      interpolateOrStep({
        lower,
        upper,
        span: 0,
        offset: 0,
        cadence: "interpolated",
      }).toString(),
    ).toBe("100000");
  });
});

describe("cadenceOrDefault", () => {
  test("null / undefined / step all read as step", () => {
    expect(cadenceOrDefault(null)).toBe("step");
    expect(cadenceOrDefault(undefined)).toBe("step");
    expect(cadenceOrDefault("step")).toBe("step");
  });

  test("interpolated is preserved", () => {
    expect(cadenceOrDefault("interpolated")).toBe("interpolated");
  });
});

describe("sampleDateForCadence", () => {
  test("step snaps to the first of the target's month", () => {
    expect(sampleDateForCadence("2024-03-17", "step")).toBe("2024-03-01");
    expect(sampleDateForCadence("2024-03-01", "step")).toBe("2024-03-01");
  });

  test("step handles month, year, and leap-February boundaries", () => {
    expect(sampleDateForCadence("2024-02-29", "step")).toBe("2024-02-01"); // leap Feb
    expect(sampleDateForCadence("2024-12-31", "step")).toBe("2024-12-01"); // year end
    expect(sampleDateForCadence("2025-01-01", "step")).toBe("2025-01-01"); // year start
  });

  test("interpolated returns the exact target date", () => {
    expect(sampleDateForCadence("2024-03-17", "interpolated")).toBe("2024-03-17");
    expect(sampleDateForCadence("2024-02-29", "interpolated")).toBe("2024-02-29");
  });
});
