import type {
  AttachmentExtractionResult,
  ExtractedDocument,
} from "@web/asistente/attachment-extraction-contract";
import { describe, expect, it } from "vitest";

import {
  gradeBalanceSeriesAgainstExpected,
  gradeExtractionAgainstExpected,
  gradePositionsMovementsAgainstExpected,
  NO_HALLUCINATION_CHECK_NAME,
} from "./graders";
import type {
  BalanceSeriesGoldenExpected,
  GoldenExpectedNegative,
  GoldenExpectedPositive,
  PositionsMovementsGoldenExpected,
} from "./manifest";

const BASELINE: GoldenExpectedPositive = {
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

const validResult = (data: GoldenExpectedPositive): AttachmentExtractionResult => ({
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

  it("reads a truncated name through either spelling of the ellipsis", () => {
    // What the value-only composition capture actually does (#1345): the screen cuts
    // two fund names with «…» and the model types the same truncation as «...». The
    // fund WAS read, so failing it would grade the encoding of a printed mark — the
    // fold sits next to the diacritics one, which exists for the same reason.
    const truncated = {
      currency: "EUR",
      marketValueEur: 154.1,
      name: "Fondo Índice Mercados Emergent…",
    };
    const checks = gradeExtractionAgainstExpected(
      validResult({
        positions: [{ ...truncated, name: "Fondo Indice Mercados Emergent..." }],
        warnings: [],
      }),
      { positions: [truncated], warnings: [] },
    );

    expect(checks.every((check) => check.pass)).toBe(true);
  });

  it("still fails when the truncation itself is not what the screen printed", () => {
    const checks = gradeExtractionAgainstExpected(
      validResult({
        positions: [
          {
            currency: "EUR",
            marketValueEur: 154.1,
            name: "Fondo Índice Mercados Emergentes Globales",
          },
        ],
        warnings: [],
      }),
      {
        positions: [
          {
            currency: "EUR",
            marketValueEur: 154.1,
            name: "Fondo Índice Mercados Emergent…",
          },
        ],
        warnings: [],
      },
    );

    expect(
      checks.some((check) => check.name === "posiciones coinciden" && !check.pass),
    ).toBe(true);
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

const NEGATIVE: GoldenExpectedNegative = { expect: "unrecognized" };

describe("gradeExtractionAgainstExpected · negative case", () => {
  it("passes when the extractor refuses to recognize the capture", () => {
    const checks = gradeExtractionAgainstExpected(
      {
        message: "No reconozco posiciones de inversión en esta captura.",
        status: "unrecognized",
      },
      NEGATIVE,
    );

    expect(checks).toEqual([{ name: NO_HALLUCINATION_CHECK_NAME, pass: true }]);
  });

  it("fails and names the hallucinated positions", () => {
    const checks = gradeExtractionAgainstExpected(validResult(BASELINE), NEGATIVE);

    expect(checks).toHaveLength(1);
    expect(checks[0]!.pass).toBe(false);
    expect(checks[0]!.name).toContain(NO_HALLUCINATION_CHECK_NAME);
    expect(checks[0]!.name).toContain("VWCE");
    expect(checks[0]!.name).toContain("SXR8");
  });

  it("fails when the extractor answers with another status than unrecognized", () => {
    const checks = gradeExtractionAgainstExpected(
      {
        code: "extractor_unavailable",
        failure: "transient",
        message: "El extractor no está disponible.",
        status: "failure",
      },
      NEGATIVE,
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]!.pass).toBe(false);
    expect(checks[0]!.name).toContain("failure");
  });

  it("fails when the capture is rejected for being out of limits", () => {
    const checks = gradeExtractionAgainstExpected(
      {
        message: "La imagen supera el tamaño admitido.",
        reason: "size",
        status: "out_of_limits",
      },
      NEGATIVE,
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]!.pass).toBe(false);
    expect(checks[0]!.name).toContain("out_of_limits");
  });

  it("fails when the extractor returns another document type", () => {
    const checks = gradeExtractionAgainstExpected(
      validPositionsMovementsResult(POSITIONS_MOVEMENTS_BASELINE),
      NEGATIVE,
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]!.pass).toBe(false);
    expect(checks[0]!.name).toContain("positions_movements");
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

const POSITIONS_MOVEMENTS_BASELINE: PositionsMovementsGoldenExpected = {
  holdings: [
    {
      currency: "EUR",
      fidelity: "movements",
      isin: "IE00B3RBWM25",
      name: "Vanguard FTSE All-World",
      type: "Fondo indexado",
      value: 1234.56,
    },
    {
      currency: "EUR",
      fidelity: "value_only",
      name: "Banco Santander",
      type: "Acción",
      value: 765.44,
    },
  ],
  movementCount: 1,
};

const validPositionsMovementsResult = (
  data: PositionsMovementsGoldenExpected,
): AttachmentExtractionResult => ({
  data: {
    documentType: "positions_movements",
    holdings: data.holdings,
    movements: Array.from({ length: data.movementCount ?? 0 }, () => ({
      amount: 1000,
      currency: "EUR",
      date: "2026-01-15",
      kind: "buy",
      name: "Vanguard FTSE All-World",
    })),
    warnings: [],
  } as unknown as ExtractedDocument,
  status: "valid",
});

describe("gradePositionsMovementsAgainstExpected", () => {
  it("passes when every holding, its fidelity tier and the movement count match", () => {
    const checks = gradePositionsMovementsAgainstExpected(
      validPositionsMovementsResult(POSITIONS_MOVEMENTS_BASELINE),
      POSITIONS_MOVEMENTS_BASELINE,
    );
    expect(checks.every((check) => check.pass)).toBe(true);
  });

  it("fails when a holding's honest tier drifts from expected", () => {
    const checks = gradePositionsMovementsAgainstExpected(
      validPositionsMovementsResult({
        ...POSITIONS_MOVEMENTS_BASELINE,
        holdings: [
          { ...POSITIONS_MOVEMENTS_BASELINE.holdings[0]!, fidelity: "value_only" },
          POSITIONS_MOVEMENTS_BASELINE.holdings[1]!,
        ],
      }),
      POSITIONS_MOVEMENTS_BASELINE,
    );
    expect(
      checks.some((check) => check.name === "holdings y tier coinciden" && !check.pass),
    ).toBe(true);
  });

  it("fails a positions result graded on the positions + movements track", () => {
    const checks = gradePositionsMovementsAgainstExpected(
      validResult(BASELINE),
      POSITIONS_MOVEMENTS_BASELINE,
    );
    expect(checks).toContainEqual({
      name: "documento de posiciones + movimientos",
      pass: false,
    });
  });
});
