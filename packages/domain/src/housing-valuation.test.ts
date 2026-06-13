import { describe, expect, test } from "vitest";

import { valueHousingAtDate } from "./housing-valuation";
import type { HousingValuationAnchor } from "./housing-valuation";

/**
 * Pure housing-valuation curve (PRD #108, slice 4).
 *
 * Market appraisals (adjustsPriorCurve = true) carry the TOTAL value; they are
 * the truth at their date and anchor a base curve net of improvements before
 * them. Improvements (adjustsPriorCurve = false) carry an INCREMENT and are
 * layered on top. Interpolation and compound extrapolation are always by days.
 */

const market = (valuationDate: string, valueMinor: number): HousingValuationAnchor => ({
  adjustsPriorCurve: true,
  valuationDate,
  valueMinor,
});

const improvement = (
  valuationDate: string,
  valueMinor: number,
): HousingValuationAnchor => ({
  adjustsPriorCurve: false,
  valuationDate,
  valueMinor,
});

describe("valueHousingAtDate — PRD pinned example", () => {
  const anchors: HousingValuationAnchor[] = [
    market("2024-01-01", 100_000_00),
    improvement("2024-07-01", 10_000_00),
    market("2025-01-01", 120_000_00),
  ];
  const rate = "0.03";
  const today = "2026-06-12";

  const at = (date: string): number =>
    valueHousingAtDate({
      anchors,
      annualAppreciationRate: rate,
      currentValueMinor: 130_000_00,
      today,
      targetDate: date,
    });

  test("2024-01-01 → 100.000,00 € (first appraisal, no prior improvements)", () => {
    expect(at("2024-01-01")).toBe(100_000_00);
  });

  test("2024-07-01 → 114.972,68 € (interpolated base + improvement)", () => {
    expect(at("2024-07-01")).toBe(114_972_68);
  });

  test("2024-10-01 → 117.486,34 € (interpolated base + improvement)", () => {
    expect(at("2024-10-01")).toBe(117_486_34);
  });

  test("2025-01-01 → 120.000,00 € (appraisal is total truth)", () => {
    expect(at("2025-01-01")).toBe(120_000_00);
  });

  test("2025-07-01 → ≈121.772,03 € (compound extrapolation, no later improvements)", () => {
    // PRD marks this value with ≈: it is the day-based compounding of the last
    // appraisal, 120000 × 1.03^(181/365). The cents land on 121.771,91 €.
    expect(at("2025-07-01") / 100).toBeCloseTo(121_772.03, 0);
    expect(at("2025-07-01")).toBe(121_771_91);
  });
});

describe("valueHousingAtDate — base curve separation", () => {
  test("improvements before an appraisal are netted out of its base", () => {
    // Appraisal at 2025-01-01 = 120k, improvement of 10k at 2024-07-01 → base
    // 110k. Asking exactly at the appraisal returns the appraisal value.
    const value = valueHousingAtDate({
      anchors: [
        market("2024-01-01", 100_000_00),
        improvement("2024-07-01", 10_000_00),
        market("2025-01-01", 120_000_00),
      ],
      annualAppreciationRate: "0.03",
      currentValueMinor: 130_000_00,
      today: "2026-06-12",
      targetDate: "2025-01-01",
    });
    expect(value).toBe(120_000_00);
  });
});

describe("valueHousingAtDate — extrapolation before the first appraisal", () => {
  const anchors = [market("2024-01-01", 100_000_00)];

  test("with a rate, discounts the base compound by days into the past", () => {
    // 100000 × 1.03^(-365/365) = 100000 / 1.03 = 97087.378… → 97.087,38 €.
    const value = valueHousingAtDate({
      anchors,
      annualAppreciationRate: "0.03",
      currentValueMinor: 100_000_00,
      today: "2025-06-01",
      targetDate: "2023-01-01",
    });
    expect(value).toBe(97_087_38);
  });

  test("without a rate, holds the first appraisal base flat into the past", () => {
    const value = valueHousingAtDate({
      anchors,
      currentValueMinor: 100_000_00,
      today: "2025-06-01",
      targetDate: "2020-01-01",
    });
    expect(value).toBe(100_000_00);
  });

  test("adds improvements dated on or before the target", () => {
    const value = valueHousingAtDate({
      anchors: [improvement("2022-06-01", 5_000_00), market("2024-01-01", 100_000_00)],
      currentValueMinor: 105_000_00,
      today: "2025-06-01",
      targetDate: "2023-01-01",
    });
    // The appraisal total 100000 already folds in the 2022 improvement, so its
    // base is 95000. No rate → base held flat at 95000, plus the 5000 improvement
    // (≤ target) layered back on → 100000.
    expect(value).toBe(100_000_00);
  });
});

describe("valueHousingAtDate — extrapolation after the last appraisal", () => {
  test("without a rate, holds the last appraisal flat plus later improvements", () => {
    const value = valueHousingAtDate({
      anchors: [market("2024-01-01", 100_000_00), improvement("2024-07-01", 10_000_00)],
      currentValueMinor: 130_000_00,
      today: "2026-06-12",
      targetDate: "2025-01-01",
    });
    // Last appraisal 100000 held flat (total truth), plus the 10000 improvement
    // after it.
    expect(value).toBe(110_000_00);
  });

  test("only improvements strictly after the last appraisal are added", () => {
    const value = valueHousingAtDate({
      anchors: [
        improvement("2023-06-01", 3_000_00),
        market("2024-01-01", 100_000_00),
        improvement("2024-07-01", 10_000_00),
      ],
      currentValueMinor: 130_000_00,
      today: "2026-06-12",
      targetDate: "2025-01-01",
    });
    // The 2023 improvement is folded into the appraisal's truth; only the 2024-07
    // improvement is added on top.
    expect(value).toBe(110_000_00);
  });
});

describe("valueHousingAtDate — no appraisals", () => {
  test("currentValue acts as an implicit appraisal today; flat back without rate", () => {
    const value = valueHousingAtDate({
      anchors: [improvement("2024-07-01", 10_000_00)],
      currentValueMinor: 110_000_00,
      today: "2026-06-12",
      targetDate: "2025-01-01",
    });
    // base today = 110000 − 10000 (the only improvement) = 100000. No rate → flat
    // back to 2025-01-01, plus the 10000 improvement (≤ target).
    expect(value).toBe(110_000_00);
  });

  test("currentValue compounds backward with a rate", () => {
    const value = valueHousingAtDate({
      anchors: [],
      annualAppreciationRate: "0.03",
      currentValueMinor: 103_000_00,
      today: "2025-01-01",
      targetDate: "2024-01-01",
    });
    // base today = 103000 (no improvements). 366 days back (2024 leap year) →
    // 103000 × 1.03^(-366/366) = 103000 / 1.03 = 100000.
    expect(value).toBe(100_000_00);
  });

  test("no anchors and no rate → currentValue is constant", () => {
    const value = valueHousingAtDate({
      anchors: [],
      currentValueMinor: 250_000_00,
      today: "2026-06-12",
      targetDate: "2019-01-01",
    });
    expect(value).toBe(250_000_00);
  });
});

describe("valueHousingAtDate — interpolation between two appraisals", () => {
  test("linear interpolation by days on the base curve", () => {
    const value = valueHousingAtDate({
      anchors: [market("2024-01-01", 100_000_00), market("2025-01-01", 200_000_00)],
      currentValueMinor: 200_000_00,
      today: "2026-06-12",
      // 183 days into a 366-day span → halfway-ish.
      targetDate: "2024-07-02",
    });
    // 100000 + 100000 × 183/366 = 150000.
    expect(value).toBe(150_000_00);
  });
});
