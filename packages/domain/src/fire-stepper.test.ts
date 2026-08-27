import { describe, expect, it } from "vitest";

import { AGGREGATE_BUCKET_ID, runFireGrowth } from "./fire-stepper";

/**
 * El contrato del único paso de crecimiento (#1597). Lo que se clava aquí es lo que
 * los tres modos —escalar, plan y familia— heredan sin volver a escribirlo.
 */
describe("runFireGrowth", () => {
  const oneBucket = (amountMinor: number) =>
    new Map([[AGGREGATE_BUCKET_ID, amountMinor]]);

  it("crece primero y aporta después: la aportación del año no compone ese año", () => {
    const run = runFireGrowth({
      annualRateFor: () => 0.1,
      contributionsForYear: () => new Map([[AGGREGATE_BUCKET_ID, 1_000]]),
      maxYears: 2,
      startingBucketsMinor: oneBucket(10_000),
      targetsMinor: { fire: Number.POSITIVE_INFINITY },
    });

    // 10.000 → ×1,1 = 11.000 → +1.000 = 12.000 (y no 12.100).
    expect(run.trajectory).toEqual([
      { year: 0, eligibleMinor: 10_000 },
      { year: 1, eligibleMinor: 12_000 },
      { year: 2, eligibleMinor: 14_200 },
    ]);
    expect(run.contributedThroughYearMinor).toEqual([0, 1_000, 2_000]);
  });

  it("cronometra varias dianas sobre UNA sola corrida", () => {
    const run = runFireGrowth({
      annualRateFor: () => 0,
      contributionsForYear: () => new Map([[AGGREGATE_BUCKET_ID, 1_000]]),
      maxYears: 10,
      startingBucketsMinor: oneBucket(0),
      targetsMinor: { lean: 2_000, fat: 5_000 },
    });

    expect(run.yearsToTarget).toEqual({ lean: 2, fat: 5 });
    // Para en la diana MÁS ALTA, no en la primera: la baja queda fechada sobre la
    // misma trayectoria en vez de pedir una segunda pasada.
    expect(run.trajectory.at(-1)).toEqual({ year: 5, eligibleMinor: 5_000 });
  });

  it("no da ni un paso cuando el capital ya pasa la diana más alta", () => {
    const run = runFireGrowth({
      annualRateFor: () => 0.05,
      contributionsForYear: () => new Map([[AGGREGATE_BUCKET_ID, 1_000]]),
      maxYears: 10,
      startingBucketsMinor: oneBucket(9_000),
      targetsMinor: { lean: 5_000, fat: 8_000 },
    });

    expect(run.yearsToTarget).toEqual({ lean: 0, fat: 0 });
    expect(run.trajectory).toEqual([{ year: 0, eligibleMinor: 9_000 }]);
    expect(run.contributedThroughYearMinor).toEqual([0]);
  });

  it("deja la diana en null cuando el horizonte se acaba antes", () => {
    const run = runFireGrowth({
      annualRateFor: () => 0,
      contributionsForYear: () => new Map([[AGGREGATE_BUCKET_ID, 1_000]]),
      maxYears: 3,
      startingBucketsMinor: oneBucket(0),
      targetsMinor: { fire: 99_000 },
    });

    expect(run.yearsToTarget).toEqual({ fire: null });
    expect(run.trajectory.at(-1)).toEqual({ year: 3, eligibleMinor: 3_000 });
    expect(run.contributedThroughYearMinor.at(-1)).toBe(3_000);
  });

  it("se niega a correr sin ninguna diana en vez de fingir que ya se llegó", () => {
    expect(() =>
      runFireGrowth({
        annualRateFor: () => 0.05,
        maxYears: 10,
        startingBucketsMinor: oneBucket(1_000),
        targetsMinor: {},
      }),
    ).toThrow(/al menos una diana/);
  });

  it("cada cubo crece a su tasa y las aportaciones caen en el suyo", () => {
    const run = runFireGrowth({
      annualRateFor: (bucketId) => (bucketId === "growth" ? 0.1 : 0),
      contributionsForYear: (year) => (year === 1 ? new Map([["cash", 500]]) : undefined),
      maxYears: 1,
      startingBucketsMinor: new Map([
        ["cash", 1_000],
        ["growth", 1_000],
      ]),
      targetsMinor: { fire: Number.POSITIVE_INFINITY },
    });

    // cash 1.000 (sin crecer) + 500 aportados; growth 1.100.
    expect(run.trajectory.at(-1)).toEqual({ year: 1, eligibleMinor: 2_600 });
    expect(run.contributedThroughYearMinor).toEqual([0, 500]);
  });
});
