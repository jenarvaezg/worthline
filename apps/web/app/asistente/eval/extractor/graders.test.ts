import type {
  AttachmentExtractionResult,
  ExtractedPositions,
} from "@web/asistente/attachment-extraction-contract";
import { describe, expect, it } from "vitest";

import { gradeExtractionAgainstExpected } from "./graders";
import type { GoldenExpected } from "./manifest";

const BASELINE: GoldenExpected = {
  positions: [
    {
      currency: "EUR",
      marketValueEur: 13450.32,
      name: "Vanguard FTSE All-World",
      ticker: "VWCE",
      units: 120,
    },
    {
      currency: "EUR",
      marketValueEur: 9876.5,
      name: "iShares Core S&P 500",
      ticker: "SXR8",
      units: 18,
    },
  ],
  totalEur: 23326.82,
  warnings: [],
};

const validResult = (data: GoldenExpected): AttachmentExtractionResult => ({
  data: {
    positions: data.positions,
    totalEur: data.totalEur,
    warnings: data.warnings,
  } as ExtractedPositions,
  status: "valid",
});

describe("gradeExtractionAgainstExpected", () => {
  it("passes when every field, uncertain flag and warning match", () => {
    const checks = gradeExtractionAgainstExpected(
      validResult({
        positions: [
          { ...BASELINE.positions[0]!, uncertain: true },
          BASELINE.positions[1]!,
        ],
        totalEur: BASELINE.totalEur,
        warnings: ["Reflejo en la esquina superior."],
      }),
      {
        ...BASELINE,
        mustBeUncertain: ["VWCE"],
        warningIncludes: ["reflejo"],
      },
    );

    expect(checks.every((check) => check.pass)).toBe(true);
  });

  it("fails when extraction is not valid", () => {
    const checks = gradeExtractionAgainstExpected(
      {
        message: "No reconozco posiciones de inversión en esta captura.",
        status: "unrecognized",
      },
      BASELINE,
    );

    expect(checks).toContainEqual({
      name: "extracción válida",
      pass: false,
    });
  });

  it("fails when a position field drifts", () => {
    const checks = gradeExtractionAgainstExpected(
      validResult({
        positions: [{ ...BASELINE.positions[0]!, units: 121 }, BASELINE.positions[1]!],
        totalEur: BASELINE.totalEur,
        warnings: [],
      }),
      BASELINE,
    );

    expect(
      checks.some((check) => check.name === "posiciones coinciden" && !check.pass),
    ).toBe(true);
  });

  it("requires uncertain visibility when the fixture expects it", () => {
    const checks = gradeExtractionAgainstExpected(
      validResult({
        positions: BASELINE.positions,
        totalEur: BASELINE.totalEur,
        warnings: [],
      }),
      { ...BASELINE, mustBeUncertain: ["SXR8"] },
    );

    expect(checks).toContainEqual({
      name: "uncertain visible",
      pass: false,
    });
  });

  it("requires expected warning fragments", () => {
    const checks = gradeExtractionAgainstExpected(
      validResult({
        positions: BASELINE.positions,
        totalEur: BASELINE.totalEur,
        warnings: ["Todo claro."],
      }),
      { ...BASELINE, warningIncludes: ["separador"] },
    );

    expect(checks).toContainEqual({
      name: "warnings visibles",
      pass: false,
    });
  });
});
