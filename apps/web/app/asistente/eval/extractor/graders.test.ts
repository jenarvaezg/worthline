import type {
  AttachmentExtractionResult,
  ExtractedDocument,
} from "@web/asistente/attachment-extraction-contract";
import { describe, expect, it } from "vitest";

import {
  gradeBalanceSeriesAgainstExpected,
  gradeExtractionAgainstExpected,
} from "./graders";
import type { BalanceSeriesGoldenExpected, GoldenExpected } from "./manifest";

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
    documentType: "positions",
    positions: data.positions,
    totalEur: data.totalEur,
    warnings: data.warnings,
  } as ExtractedDocument,
  status: "valid",
});

const validBalanceSeriesResult = (
  data: BalanceSeriesGoldenExpected,
): AttachmentExtractionResult => ({
  data: {
    documentType: "balance_series",
    balances: data.balances,
    warnings: data.warnings,
  } as ExtractedDocument,
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

const BALANCE_BASELINE: BalanceSeriesGoldenExpected = {
  balances: [
    { amount: 5592, currency: "EUR", date: "2026-06-30" },
    { amount: 5401.12, currency: "EUR", date: "2026-07-31" },
  ],
  warnings: [],
};

describe("gradeBalanceSeriesAgainstExpected", () => {
  it("passes when every dated balance, uncertain date and warning match", () => {
    const checks = gradeBalanceSeriesAgainstExpected(
      validBalanceSeriesResult({
        balances: [
          { ...BALANCE_BASELINE.balances[0]!, uncertain: true },
          BALANCE_BASELINE.balances[1]!,
        ],
        warnings: ["Reflejo en la esquina."],
      }),
      {
        ...BALANCE_BASELINE,
        mustBeUncertain: ["2026-06-30"],
        warningIncludes: ["reflejo"],
      },
    );

    expect(checks.every((check) => check.pass)).toBe(true);
  });

  it("fails when a balance amount drifts", () => {
    const checks = gradeBalanceSeriesAgainstExpected(
      validBalanceSeriesResult({
        balances: [
          { ...BALANCE_BASELINE.balances[0]!, amount: 9999 },
          BALANCE_BASELINE.balances[1]!,
        ],
        warnings: [],
      }),
      BALANCE_BASELINE,
    );

    expect(checks.some((check) => check.name === "saldos coinciden" && !check.pass)).toBe(
      true,
    );
  });

  it("fails a positions result graded on the balance-series track", () => {
    const checks = gradeBalanceSeriesAgainstExpected(
      validResult(BASELINE),
      BALANCE_BASELINE,
    );

    expect(checks).toContainEqual({
      name: "documento de saldos fechados",
      pass: false,
    });
  });
});
