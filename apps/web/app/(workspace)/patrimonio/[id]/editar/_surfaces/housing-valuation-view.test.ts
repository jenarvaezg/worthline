import { describe, expect, test } from "vitest";

import {
  anchorKindLabel,
  latestAnchor,
  resultAgainstCost,
} from "./housing-valuation-view";

/**
 * The rules a property's ficha reads twice — in its state header and in the
 * «Valoración» tab (#1847) — written once, so the two can never disagree.
 */

const acquisition = {
  adjustsPriorCurve: true,
  id: "a_acq",
  kind: "acquisition" as const,
  valuationDate: "2020-05-10",
  valueMinor: 200_000_00,
};
const appraisal = {
  adjustsPriorCurve: true,
  id: "a_tas",
  kind: null,
  valuationDate: "2024-03-15",
  valueMinor: 180_000_00,
};
const improvement = {
  adjustsPriorCurve: false,
  id: "a_mej",
  kind: null,
  valuationDate: "2025-01-20",
  valueMinor: 15_000_00,
};

describe("anchorKindLabel — the words of the Tipo column", () => {
  test("an acquisition, an appraisal and an improvement", () => {
    expect(anchorKindLabel(acquisition)).toBe("Adquisición");
    expect(anchorKindLabel(appraisal)).toBe("Tasación");
    expect(anchorKindLabel(improvement)).toBe("Mejora");
  });
});

describe("latestAnchor — «Última tasación»", () => {
  test("the most recent one, whatever the order they come in", () => {
    expect(latestAnchor([improvement, acquisition, appraisal], "2026-10-13")).toBe(
      improvement,
    );
  });

  test("one dated after today does not count yet", () => {
    expect(latestAnchor([acquisition, appraisal], "2024-03-14")).toBe(acquisition);
    // On its own day it does.
    expect(latestAnchor([acquisition, appraisal], "2024-03-15")).toBe(appraisal);
  });

  test("none: null", () => {
    expect(latestAnchor([], "2026-10-13")).toBeNull();
    expect(latestAnchor([appraisal], "2020-01-01")).toBeNull();
  });
});

describe("resultAgainstCost — «Resultado frente al coste» (#1441)", () => {
  test("Yeles: worth 48.000 € against 53.354,55 € disbursed is a loss", () => {
    expect(
      resultAgainstCost(53_354_55, { amountMinor: 48_000_00, currency: "EUR" }),
    ).toEqual({ amountMinor: -5_354_55, currency: "EUR" });
  });

  test("measured against the value it is handed, in that value's currency", () => {
    expect(
      resultAgainstCost(200_000_00, { amountMinor: 231_500_00, currency: "EUR" }),
    ).toEqual({ amountMinor: 31_500_00, currency: "EUR" });
  });

  test("without a cost there is no result — no invented 0 %", () => {
    expect(resultAgainstCost(null, { amountMinor: 240_000_00, currency: "EUR" })).toBe(
      null,
    );
  });

  test("without a value there is none either: a valuation that has not happened", () => {
    expect(resultAgainstCost(200_000_00, { amountMinor: 0, currency: "EUR" })).toBe(null);
  });
});
