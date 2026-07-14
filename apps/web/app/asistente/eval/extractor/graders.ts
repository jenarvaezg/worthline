import type { AttachmentExtractionResult } from "@web/asistente/attachment-extraction-contract";

import type { GoldenExpected } from "./manifest";

export interface ExtractorCheck {
  name: string;
  pass: boolean;
}

const MONEY_EPSILON = 0.015;

function numbersClose(left: number, right: number): boolean {
  return Math.abs(left - right) < MONEY_EPSILON;
}

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function warningMatches(fragment: string, warnings: readonly string[]): boolean {
  const needle = normalizeText(fragment);
  return warnings.some((warning) => normalizeText(warning).includes(needle));
}

function positionMatches(
  actual: GoldenExpected["positions"][number],
  expected: GoldenExpected["positions"][number],
): boolean {
  return (
    normalizeText(actual.ticker) === normalizeText(expected.ticker) &&
    normalizeText(actual.name) === normalizeText(expected.name) &&
    numbersClose(actual.units, expected.units) &&
    numbersClose(actual.marketValueEur, expected.marketValueEur) &&
    actual.currency === expected.currency &&
    (expected.uncertain === undefined || actual.uncertain === expected.uncertain)
  );
}

function positionsMatch(
  actual: GoldenExpected["positions"],
  expected: GoldenExpected["positions"],
): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  return expected.every((expectedPosition) => {
    const index = remaining.findIndex((candidate) =>
      positionMatches(candidate, expectedPosition),
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
    return true;
  });
}

/**
 * Grade one extractor result against the golden expected payload. Checks field
 * accuracy plus visibility of `uncertain` and `warnings`, not just schema validity.
 */
export function gradeExtractionAgainstExpected(
  result: AttachmentExtractionResult,
  expected: GoldenExpected,
): ExtractorCheck[] {
  const checks: ExtractorCheck[] = [
    {
      name: "extracción válida",
      pass: result.status === "valid",
    },
  ];
  if (result.status !== "valid") return checks;

  checks.push({
    name: "posiciones coinciden",
    pass: positionsMatch(result.data.positions, expected.positions),
  });

  if (expected.totalEur !== undefined) {
    checks.push({
      name: "total coincide",
      pass:
        result.data.totalEur !== undefined &&
        numbersClose(result.data.totalEur, expected.totalEur),
    });
  }

  const mustBeUncertain = expected.mustBeUncertain ?? [];
  checks.push({
    name: "uncertain visible",
    pass:
      mustBeUncertain.length === 0 ||
      mustBeUncertain.every((ticker) =>
        result.data.positions.some(
          (position) =>
            normalizeText(position.ticker) === normalizeText(ticker) &&
            position.uncertain === true,
        ),
      ),
  });

  const warningIncludes = expected.warningIncludes ?? [];
  checks.push({
    name: "warnings visibles",
    pass:
      warningIncludes.length === 0 ||
      warningIncludes.every((fragment) => warningMatches(fragment, result.data.warnings)),
  });

  return checks;
}
