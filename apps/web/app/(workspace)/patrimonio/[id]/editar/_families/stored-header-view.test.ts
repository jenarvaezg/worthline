import { describe, expect, test } from "vitest";
import { availabilityReading, freshnessCaption } from "./stored-header-view";

describe("freshnessCaption — «Puesto al día» in words (#1846)", () => {
  test.each([
    [0, "hoy"],
    [1, "hace 1 día"],
    [89, "hace 89 días"],
  ])("%i days, fresh: %s", (daysSince, caption) => {
    expect(
      freshnessCaption({ daysSince, lastUpdateDateKey: "2026-10-01", stale: false }),
    ).toBe(caption);
  });

  test("stale says what the aviso says, not a count", () => {
    expect(
      freshnessCaption({ daysSince: 400, lastUpdateDateKey: "2025-09-01", stale: true }),
    ).toBe("lleva más de 90 días sin actualizarse");
  });
});

describe("availabilityReading — «Disponibilidad» (#1846)", () => {
  test("a rung with no term is just its label", () => {
    expect(availabilityReading({ liquidityTier: "cash" })).toEqual({
      kind: "rung",
      label: "Caja",
    });
  });

  test("a term-locked holding with a date says since when", () => {
    expect(
      availabilityReading({ availableFrom: "2027-03-01", liquidityTier: "term-locked" }),
    ).toEqual({ kind: "since", label: "A plazo", since: "01/03/2027" });
  });

  test("a term-locked holding without one says it is undeclared", () => {
    expect(availabilityReading({ liquidityTier: "term-locked" })).toEqual({
      kind: "undeclared",
      label: "A plazo",
    });
  });

  test("declared lots rule over the single date, so it is not «sin fecha»", () => {
    expect(
      availabilityReading({
        contributionLots: [{ amountMinor: 1_000_00, availableFrom: "2030-01-01" }],
        liquidityTier: "term-locked",
      }),
    ).toEqual({ kind: "lots", label: "A plazo" });
  });
});
