import { describe, expect, test } from "vitest";

import {
  type AcquisitionEditPreviewInput,
  buildAcquisitionEditPreview,
} from "./housing-acquisition-preview";
import type { HousingValuationAnchor } from "./housing-valuation";

/**
 * The Plasencia shape (#1562): an acquisition in 2004 and one market appraisal
 * two decades later, so the whole stretch between them is interpolated. Editing
 * the acquisition redraws 22 years of curve — this module is what says so BEFORE
 * the write.
 */
const APPRAISAL_2026: HousingValuationAnchor = {
  adjustsPriorCurve: true,
  valuationDate: "2026-01-01",
  valueMinor: 20_000_000,
};

const TODAY = "2026-08-26";

function input(
  overrides: Partial<AcquisitionEditPreviewInput> = {},
): AcquisitionEditPreviewInput {
  return {
    annualAppreciationRate: null,
    currentValueMinor: 20_000_000,
    current: { valuationDate: "2004-05-19", valueMinor: 15_025_303 },
    edited: { valuationDate: "2004-05-19", valueMinor: 15_025_303 },
    otherAnchors: [APPRAISAL_2026],
    today: TODAY,
    ...overrides,
  };
}

describe("buildAcquisitionEditPreview", () => {
  test("an untouched acquisition changes nothing and ripples from its own date", () => {
    const preview = buildAcquisitionEditPreview(input());

    expect(preview.dateChanged).toBe(false);
    expect(preview.valueChanged).toBe(false);
    expect(preview.fromDateKey).toBe("2004-05-19");
    expect(preview.points.every((p) => p.deltaMinor === 0)).toBe(true);
  });

  test("moving the acquisition earlier ripples from the NEW date", () => {
    const preview = buildAcquisitionEditPreview(
      input({ edited: { valuationDate: "2002-03-01", valueMinor: 15_025_303 } }),
    );

    expect(preview.dateChanged).toBe(true);
    expect(preview.valueChanged).toBe(false);
    expect(preview.fromDateKey).toBe("2002-03-01");
  });

  test("moving the acquisition later still ripples from the OLD date", () => {
    const preview = buildAcquisitionEditPreview(
      input({ edited: { valuationDate: "2006-03-01", valueMinor: 15_025_303 } }),
    );

    expect(preview.fromDateKey).toBe("2004-05-19");
  });

  test("names both acquisition dates, the following appraisal and today, in order", () => {
    const preview = buildAcquisitionEditPreview(
      input({ edited: { valuationDate: "2006-03-01", valueMinor: 16_000_000 } }),
    );

    // Between the acquisition and the appraisal that closes the stretch, two
    // interior samples show the redraw the anchor dates alone would hide.
    expect(preview.points.map((p) => p.role)).toEqual([
      "acquisition_current",
      "acquisition_new",
      "curve",
      "curve",
      "appraisal",
      "today",
    ]);
    expect(preview.points[0]!.dateKey).toBe("2004-05-19");
    expect(preview.points[1]!.dateKey).toBe("2006-03-01");
    expect(preview.points.at(-2)!.dateKey).toBe("2026-01-01");
    expect(preview.points.at(-1)!.dateKey).toBe(TODAY);
  });

  test("a price-only edit still SHOWS the stretch it redraws (#1562)", () => {
    const preview = buildAcquisitionEditPreview(
      input({ edited: { valuationDate: "2004-05-19", valueMinor: 16_000_000 } }),
    );

    const samples = preview.points.filter((p) => p.role === "curve");
    expect(samples).toHaveLength(2);
    // The anchor dates alone would say «only the acquisition moves»; the interior
    // of the interpolated stretch moves too, and now it is on screen.
    expect(samples.every((p) => p.deltaMinor !== 0)).toBe(true);
    for (const sample of samples) {
      expect(sample.dateKey > "2004-05-19").toBe(true);
      expect(sample.dateKey < "2026-01-01").toBe(true);
    }
  });

  test("a stretch too short for a sample gets none", () => {
    const preview = buildAcquisitionEditPreview(
      input({
        current: { valuationDate: "2026-01-02", valueMinor: 15_025_303 },
        edited: { valuationDate: "2026-01-03", valueMinor: 16_000_000 },
        otherAnchors: [
          {
            adjustsPriorCurve: true,
            valuationDate: "2026-01-04",
            valueMinor: 20_000_000,
          },
        ],
      }),
    );

    expect(preview.points.some((p) => p.role === "curve")).toBe(false);
  });

  test("the acquisition date carries its own price on each side of the edit", () => {
    const preview = buildAcquisitionEditPreview(
      input({ edited: { valuationDate: "2006-03-01", valueMinor: 16_000_000 } }),
    );

    const oldDate = preview.points.find((p) => p.dateKey === "2004-05-19")!;
    const newDate = preview.points.find((p) => p.dateKey === "2006-03-01")!;

    expect(oldDate.beforeMinor).toBe(15_025_303);
    expect(newDate.afterMinor).toBe(16_000_000);
    // The interpolated stretch moves: same date, two different curves.
    expect(newDate.beforeMinor).not.toBe(newDate.afterMinor);
    expect(newDate.deltaMinor).toBe(newDate.afterMinor - newDate.beforeMinor);
  });

  test("a market appraisal after the acquisition is untouched — it is the truth at its date", () => {
    const preview = buildAcquisitionEditPreview(
      input({ edited: { valuationDate: "2006-03-01", valueMinor: 16_000_000 } }),
    );

    const appraisal = preview.points.find((p) => p.dateKey === "2026-01-01")!;
    expect(appraisal.beforeMinor).toBe(20_000_000);
    expect(appraisal.afterMinor).toBe(20_000_000);
    expect(appraisal.deltaMinor).toBe(0);
  });

  test("with no appraisal after it, the acquisition IS the curve — today moves too", () => {
    const preview = buildAcquisitionEditPreview(
      input({
        edited: { valuationDate: "2004-05-19", valueMinor: 16_000_000 },
        otherAnchors: [],
      }),
    );

    const acquisition = preview.points.find((p) => p.role === "acquisition_new")!;
    const today = preview.points.find((p) => p.role === "today")!;

    expect(preview.valueChanged).toBe(true);
    expect(acquisition.beforeMinor).toBe(15_025_303);
    expect(acquisition.afterMinor).toBe(16_000_000);
    // No later appraisal and no rate: the acquisition price holds flat to today,
    // so the edit moves every day of the curve, not just the oldest stretch.
    expect(today.beforeMinor).toBe(15_025_303);
    expect(today.afterMinor).toBe(16_000_000);
  });

  test("an improvement rides both curves as the increment it is", () => {
    const preview = buildAcquisitionEditPreview(
      input({
        edited: { valuationDate: "2004-05-19", valueMinor: 16_000_000 },
        otherAnchors: [
          {
            adjustsPriorCurve: false,
            valuationDate: "2010-06-01",
            valueMinor: 1_000_000,
          },
          APPRAISAL_2026,
        ],
      }),
    );

    const improvement = preview.points.find((p) => p.dateKey === "2010-06-01")!;
    expect(improvement.role).toBe("improvement");
    expect(improvement.afterMinor).toBeGreaterThan(improvement.beforeMinor);
  });

  test("a date shared by the edit and an anchor is listed once", () => {
    const preview = buildAcquisitionEditPreview(
      input({
        current: { valuationDate: "2026-01-01", valueMinor: 15_025_303 },
        edited: { valuationDate: "2026-01-01", valueMinor: 16_000_000 },
      }),
    );

    expect(preview.points.filter((p) => p.dateKey === "2026-01-01")).toHaveLength(1);
    expect(preview.points.find((p) => p.dateKey === "2026-01-01")!.role).toBe(
      "acquisition_new",
    );
  });
});
