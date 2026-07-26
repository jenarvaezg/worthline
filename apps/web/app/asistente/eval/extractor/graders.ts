import type { AttachmentExtractionResult } from "@web/asistente/attachment-extraction-contract";

import {
  type BalanceSeriesGoldenExpected,
  type GoldenExpected,
  type GoldenExpectedPositive,
  isNegativeGoldenExpected,
  type PositionsMovementsGoldenExpected,
} from "./manifest";

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
  actual: GoldenExpectedPositive["positions"][number],
  expected: GoldenExpectedPositive["positions"][number],
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
  actual: GoldenExpectedPositive["positions"],
  expected: GoldenExpectedPositive["positions"],
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

/** The single check a negative fixture is graded on (#1247). */
export const NO_HALLUCINATION_CHECK_NAME = "no alucina posiciones";

const MAX_LISTED_HALLUCINATED_POSITIONS = 5;

/** Name what the extractor answered, so a failing negative case is actionable. */
function describeUnexpectedRecognition(result: AttachmentExtractionResult): string {
  if (result.status !== "valid") return `devolvió «${result.status}»`;
  if (result.data.documentType !== "positions") {
    return `extrajo un documento «${result.data.documentType}»`;
  }
  const positions = result.data.positions;
  const listed = positions
    .slice(0, MAX_LISTED_HALLUCINATED_POSITIONS)
    .map((position) => `${position.ticker} ×${position.units}`)
    .join(", ");
  const rest = positions.length - MAX_LISTED_HALLUCINATED_POSITIONS;
  const suffix = rest > 0 ? ` y ${rest} más` : "";
  return `inventó ${positions.length} posiciones: ${listed}${suffix}`;
}

/**
 * Grade a negative fixture: the capture is not a portfolio, so the only honest
 * answer is `unrecognized`. Anything else — an extraction, another document type,
 * a provider failure — is a miss, and the check name says what came back instead.
 */
function gradeNegativeExpectation(result: AttachmentExtractionResult): ExtractorCheck[] {
  if (result.status === "unrecognized") {
    return [{ name: NO_HALLUCINATION_CHECK_NAME, pass: true }];
  }
  return [
    {
      name: `${NO_HALLUCINATION_CHECK_NAME} — ${describeUnexpectedRecognition(result)}`,
      pass: false,
    },
  ];
}

/**
 * Grade one extractor result against the golden expected payload. Checks field
 * accuracy plus visibility of `uncertain` and `warnings`, not just schema validity.
 * A negative expected inverts the question: nothing may be extracted at all.
 */
export function gradeExtractionAgainstExpected(
  result: AttachmentExtractionResult,
  expected: GoldenExpected,
): ExtractorCheck[] {
  if (isNegativeGoldenExpected(expected)) return gradeNegativeExpectation(result);

  const checks: ExtractorCheck[] = [
    {
      name: "extracción válida",
      pass: result.status === "valid",
    },
  ];
  if (result.status !== "valid") return checks;
  if (result.data.documentType !== "positions") {
    checks.push({ name: "documento de posiciones", pass: false });
    return checks;
  }
  const data = result.data;

  checks.push({
    name: "posiciones coinciden",
    pass: positionsMatch(data.positions, expected.positions),
  });

  if (expected.totalEur !== undefined) {
    checks.push({
      name: "total coincide",
      pass: data.totalEur !== undefined && numbersClose(data.totalEur, expected.totalEur),
    });
  }

  const mustBeUncertain = expected.mustBeUncertain ?? [];
  checks.push({
    name: "uncertain visible",
    pass:
      mustBeUncertain.length === 0 ||
      mustBeUncertain.every((ticker) =>
        data.positions.some(
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
      warningIncludes.every((fragment) => warningMatches(fragment, data.warnings)),
  });

  return checks;
}

function holdingMatches(
  actual: {
    name: string;
    type: string;
    isin?: string | undefined;
    value: number;
    currency: string;
    fidelity: string;
  },
  expected: PositionsMovementsGoldenExpected["holdings"][number],
): boolean {
  return (
    normalizeText(actual.name) === normalizeText(expected.name) &&
    normalizeText(actual.type) === normalizeText(expected.type) &&
    actual.isin === expected.isin &&
    numbersClose(actual.value, expected.value) &&
    actual.currency === expected.currency &&
    actual.fidelity === expected.fidelity
  );
}

function holdingsMatch(
  actual: PositionsMovementsGoldenExpected["holdings"],
  expected: PositionsMovementsGoldenExpected["holdings"],
): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  return expected.every((expectedHolding) => {
    const index = remaining.findIndex((candidate) =>
      holdingMatches(candidate, expectedHolding),
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
    return true;
  });
}

/**
 * Grade a positions + movements result against its golden expected portfolio.
 * Beyond field accuracy it grades the honest **fidelity tier** of each holding —
 * the mark the reconcile surface paints — and the movement count and warnings.
 */
export function gradePositionsMovementsAgainstExpected(
  result: AttachmentExtractionResult,
  expected: PositionsMovementsGoldenExpected,
): ExtractorCheck[] {
  const checks: ExtractorCheck[] = [
    { name: "extracción válida", pass: result.status === "valid" },
  ];
  if (result.status !== "valid") return checks;
  if (result.data.documentType !== "positions_movements") {
    checks.push({ name: "documento de posiciones + movimientos", pass: false });
    return checks;
  }
  const data = result.data;

  checks.push({
    name: "holdings y tier coinciden",
    pass: holdingsMatch(data.holdings, expected.holdings),
  });

  if (expected.movementCount !== undefined) {
    checks.push({
      name: "movimientos coinciden",
      pass: data.movements.length === expected.movementCount,
    });
  }

  const warningIncludes = expected.warningIncludes ?? [];
  checks.push({
    name: "warnings visibles",
    pass:
      warningIncludes.length === 0 ||
      warningIncludes.every((fragment) => warningMatches(fragment, data.warnings)),
  });

  return checks;
}

function balanceMatches(
  actual: BalanceSeriesGoldenExpected["balances"][number],
  expected: BalanceSeriesGoldenExpected["balances"][number],
): boolean {
  return (
    actual.date === expected.date &&
    numbersClose(actual.amount, expected.amount) &&
    actual.currency === expected.currency &&
    (expected.uncertain === undefined || actual.uncertain === expected.uncertain)
  );
}

function balancesMatch(
  actual: BalanceSeriesGoldenExpected["balances"],
  expected: BalanceSeriesGoldenExpected["balances"],
): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  return expected.every((expectedBalance) => {
    const index = remaining.findIndex((candidate) =>
      balanceMatches(candidate, expectedBalance),
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
    return true;
  });
}

/**
 * Grade a PDF balance-series result against its golden expected series. Mirrors
 * the positions grader: dated-balance accuracy plus visibility of expected
 * `uncertain` dates and `warnings`, not just schema validity.
 */
export function gradeBalanceSeriesAgainstExpected(
  result: AttachmentExtractionResult,
  expected: BalanceSeriesGoldenExpected,
): ExtractorCheck[] {
  const checks: ExtractorCheck[] = [
    { name: "extracción válida", pass: result.status === "valid" },
  ];
  if (result.status !== "valid") return checks;
  if (result.data.documentType !== "balance_series") {
    checks.push({ name: "documento de saldos fechados", pass: false });
    return checks;
  }
  const data = result.data;

  checks.push({
    name: "saldos coinciden",
    pass: balancesMatch(data.balances, expected.balances),
  });

  const mustBeUncertain = expected.mustBeUncertain ?? [];
  checks.push({
    name: "uncertain visible",
    pass:
      mustBeUncertain.length === 0 ||
      mustBeUncertain.every((date) =>
        data.balances.some(
          (balance) => balance.date === date && balance.uncertain === true,
        ),
      ),
  });

  const warningIncludes = expected.warningIncludes ?? [];
  checks.push({
    name: "warnings visibles",
    pass:
      warningIncludes.length === 0 ||
      warningIncludes.every((fragment) => warningMatches(fragment, data.warnings)),
  });

  return checks;
}
