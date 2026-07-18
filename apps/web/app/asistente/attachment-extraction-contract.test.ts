import { describe, expect, test } from "vitest";
import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  balanceSeriesDocumentSchema,
  checkAttachmentLimits,
  datedBalanceSchema,
  extractedDocumentSchema,
  extractedHoldingSchema,
  extractedMovementSchema,
  normalizeExtractedNumber,
  parseExtractionResult,
  positionsDocumentSchema,
  positionsMovementsDocumentSchema,
  resolveHoldingFidelity,
} from "./attachment-extraction-contract";

describe("attachment extraction contract", () => {
  test("normalizes Spanish financial numbers without reading them as Anglo decimals", () => {
    expect(normalizeExtractedNumber("1.234,56")).toBe(1234.56);
    expect(normalizeExtractedNumber("1234.56")).toBe(1234.56);
    expect(normalizeExtractedNumber(1234.56)).toBe(1234.56);
    expect(normalizeExtractedNumber("not a number")).toBeNull();
  });

  test("accepts and normalizes a complete positions document", () => {
    const parsed = positionsDocumentSchema.parse({
      documentType: "positions",
      positions: [
        {
          currency: "EUR",
          marketValueEur: "1.234,56",
          name: "Vanguard FTSE All-World",
          ticker: "VWCE",
          units: "10,5",
        },
      ],
      totalEur: "1.234,56",
      warnings: [],
    });

    expect(parsed).toEqual({
      documentType: "positions",
      positions: [
        {
          currency: "EUR",
          marketValueEur: 1234.56,
          name: "Vanguard FTSE All-World",
          ticker: "VWCE",
          units: 10.5,
        },
      ],
      totalEur: 1234.56,
      warnings: [],
    });
  });

  test("preserves visible uncertainty and warnings on positions", () => {
    const parsed = positionsDocumentSchema.parse({
      documentType: "positions",
      positions: [
        {
          currency: "USD",
          marketValueEur: 875.25,
          name: "Tesla",
          ticker: "TSLA",
          uncertain: true,
          units: 4,
        },
      ],
      warnings: ["La divisa de la captura no se distingue con claridad."],
    });

    expect(parsed.positions[0]?.uncertain).toBe(true);
    expect(parsed.warnings).toEqual([
      "La divisa de la captura no se distingue con claridad.",
    ]);
  });

  test.each([
    { documentType: "positions", positions: [], warnings: [] },
    {
      documentType: "positions",
      positions: [{ currency: "EUR", marketValueEur: 10, name: "Incomplete", units: 1 }],
      warnings: [],
    },
    {
      documentType: "positions",
      positions: [
        {
          currency: "EURO",
          marketValueEur: 10,
          name: "Bad currency",
          ticker: "BAD",
          units: 1,
        },
      ],
      warnings: [],
    },
    {
      documentType: "positions",
      positions: [
        {
          currency: "EUR",
          marketValueEur: "garbled",
          name: "Bad number",
          ticker: "BAD",
          units: 1,
        },
      ],
      warnings: [],
    },
    {
      documentType: "positions",
      extra: "not part of v1",
      positions: [
        {
          currency: "EUR",
          marketValueEur: 10,
          name: "Unexpected field",
          ticker: "BAD",
          units: 1,
        },
      ],
      warnings: [],
    },
    // A positions payload without its discriminant cannot enter the union.
    {
      positions: [
        {
          currency: "EUR",
          marketValueEur: 10,
          name: "Missing discriminant",
          ticker: "BAD",
          units: 1,
        },
      ],
      warnings: [],
    },
  ])("rejects malformed or partial positions %#", (raw) => {
    expect(extractedDocumentSchema.safeParse(raw).success).toBe(false);
  });

  test("accepts a complete dated balance series document", () => {
    const parsed = balanceSeriesDocumentSchema.parse({
      documentType: "balance_series",
      balances: [
        { amount: "5.592,00", currency: "EUR", date: "2026-06-30" },
        { amount: 5401.12, currency: "EUR", date: "2026-07-31", uncertain: true },
      ],
      uncertain: true,
      warnings: ["Una fila del cuadro está parcialmente tapada."],
    });

    expect(parsed.balances).toEqual([
      { amount: 5592, currency: "EUR", date: "2026-06-30" },
      { amount: 5401.12, currency: "EUR", date: "2026-07-31", uncertain: true },
    ]);
    expect(parsed.uncertain).toBe(true);
  });

  test("routes a valid balance series through the shared discriminated union", () => {
    const parsed = extractedDocumentSchema.parse({
      documentType: "balance_series",
      balances: [{ amount: 1200, currency: "EUR", date: "2026-01-15" }],
      warnings: [],
    });
    expect(parsed.documentType).toBe("balance_series");
  });

  test.each([
    // Empty series.
    { documentType: "balance_series", balances: [], warnings: [] },
    // Missing currency.
    {
      documentType: "balance_series",
      balances: [{ amount: 100, date: "2026-01-15" }],
      warnings: [],
    },
    // Non-ISO / impossible date.
    {
      documentType: "balance_series",
      balances: [{ amount: 100, currency: "EUR", date: "2026-13-40" }],
      warnings: [],
    },
    // Free-form date the model might invent instead of a real day.
    {
      documentType: "balance_series",
      balances: [{ amount: 100, currency: "EUR", date: "30 de junio" }],
      warnings: [],
    },
    // Unknown field cannot ride along.
    {
      documentType: "balance_series",
      balances: [{ amount: 100, currency: "EUR", date: "2026-01-15", note: "x" }],
      warnings: [],
    },
  ])("rejects malformed or partial balance series %#", (raw) => {
    expect(extractedDocumentSchema.safeParse(raw).success).toBe(false);
  });

  test("rejects an impossible calendar day at the dated balance seam", () => {
    expect(
      datedBalanceSchema.safeParse({ amount: 1, currency: "EUR", date: "2026-02-30" })
        .success,
    ).toBe(false);
    expect(
      datedBalanceSchema.safeParse({ amount: 1, currency: "EUR", date: "2026-02-28" })
        .success,
    ).toBe(true);
  });

  test("turns a malformed valid result into a definitive extractor failure", () => {
    expect(
      parseExtractionResult({
        data: {
          documentType: "positions",
          positions: [{ currency: "EUR", name: "Missing fields" }],
          warnings: [],
        },
        status: "valid",
      }),
    ).toEqual({
      code: "invalid_output",
      failure: "permanent",
      message: "El extractor devolvió datos incompletos o malformados.",
      status: "failure",
    });
  });

  test("preserves a valid balance series through parseExtractionResult", () => {
    const result = parseExtractionResult({
      data: {
        documentType: "balance_series",
        balances: [{ amount: 5592, currency: "EUR", date: "2026-06-30" }],
        warnings: [],
      },
      status: "valid",
    });
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.data.documentType === "balance_series") {
      expect(result.data.balances[0]?.amount).toBe(5592);
    }
  });

  test.each([
    {
      input: {
        message: "No reconozco las columnas de esta hoja.",
        status: "unrecognized",
      },
      status: "unrecognized",
    },
    {
      input: {
        message: "El PDF supera el límite de páginas.",
        reason: "pages",
        status: "out_of_limits",
      },
      status: "out_of_limits",
    },
    {
      input: {
        code: "extractor_unavailable",
        failure: "transient",
        message: "El extractor no está disponible ahora mismo.",
        status: "failure",
      },
      status: "failure",
    },
    {
      input: {
        code: "unsupported_document",
        failure: "permanent",
        message: "El extractor no puede procesar este documento.",
        status: "failure",
      },
      status: "failure",
    },
  ])("preserves the typed $status seam result", ({ input, status }) => {
    expect(parseExtractionResult(input).status).toBe(status);
  });

  test("accepts every v1 attachment family at the exact size and unit boundaries", () => {
    for (const input of [
      {
        fileName: "broker.png",
        kind: "image" as const,
        mimeType: "image/png",
        sizeBytes: 1,
      },
      {
        fileName: "broker.jpeg",
        kind: "image" as const,
        mimeType: "image/jpeg",
        sizeBytes: 1,
      },
      {
        fileName: "broker.webp",
        kind: "image" as const,
        mimeType: "image/webp",
        sizeBytes: 1,
      },
      {
        fileName: "broker.heic",
        kind: "image" as const,
        mimeType: "image/heic",
        sizeBytes: 1,
      },
      {
        fileName: "broker.heif",
        kind: "image" as const,
        mimeType: "image/heif",
        sizeBytes: 1,
      },
      {
        fileName: "positions.csv",
        kind: "spreadsheet" as const,
        mimeType: "text/csv",
        rowCount: ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows,
        sizeBytes: 1,
      },
      {
        fileName: "positions.xlsx",
        kind: "spreadsheet" as const,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        rowCount: ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows,
        sizeBytes: 1,
      },
      {
        fileName: "statement.pdf",
        kind: "pdf" as const,
        mimeType: "application/pdf",
        pageCount: ATTACHMENT_EXTRACTION_LIMITS_V1.maxPdfPages,
        sizeBytes: 1,
      },
    ]) {
      expect(
        checkAttachmentLimits({
          ...input,
          sizeBytes: ATTACHMENT_EXTRACTION_LIMITS_V1.maxBytes,
        }),
      ).toBeNull();
    }
  });

  test.each([
    {
      expected: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV, XLSX o PDF.",
      input: {
        fileName: "statement.pdf",
        kind: "image" as const,
        mimeType: "application/pdf",
        sizeBytes: 10,
      },
      reason: "type",
    },
    {
      expected: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV, XLSX o PDF.",
      input: {
        fileName: "statement.pdf",
        kind: "pdf" as const,
        mimeType: "image/png",
        pageCount: 1,
        sizeBytes: 10,
      },
      reason: "type",
    },
    {
      expected: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV, XLSX o PDF.",
      input: {
        fileName: "payload.exe",
        kind: "spreadsheet" as const,
        mimeType: "text/csv",
        rowCount: 1,
        sizeBytes: 10,
      },
      reason: "type",
    },
    {
      expected: "El archivo supera el límite de 4 MB.",
      input: {
        fileName: "broker.png",
        kind: "image" as const,
        mimeType: "image/png",
        sizeBytes: ATTACHMENT_EXTRACTION_LIMITS_V1.maxBytes + 1,
      },
      reason: "size",
    },
    {
      expected: "La hoja supera el límite de 500 filas.",
      input: {
        fileName: "positions.csv",
        kind: "spreadsheet" as const,
        mimeType: "text/csv",
        rowCount: ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows + 1,
        sizeBytes: 10,
      },
      reason: "rows",
    },
    {
      expected: `El PDF supera el límite de ${ATTACHMENT_EXTRACTION_LIMITS_V1.maxPdfPages} páginas.`,
      input: {
        fileName: "statement.pdf",
        kind: "pdf" as const,
        mimeType: "application/pdf",
        pageCount: ATTACHMENT_EXTRACTION_LIMITS_V1.maxPdfPages + 1,
        sizeBytes: 10,
      },
      reason: "pages",
    },
  ])("returns a comprehensible $reason limit result", ({ expected, input, reason }) => {
    expect(checkAttachmentLimits(input)).toEqual({
      message: expected,
      reason,
      status: "out_of_limits",
    });
  });

  test("requires spreadsheet row counts and pdf page counts at the typed limit seam", () => {
    const checkTypedInput = (input: Parameters<typeof checkAttachmentLimits>[0]) => input;

    // @ts-expect-error Spreadsheet inputs cannot omit the row count.
    checkTypedInput({
      fileName: "positions.csv",
      kind: "spreadsheet",
      mimeType: "text/csv",
      sizeBytes: 10,
    });

    // @ts-expect-error PDF inputs cannot omit the page count.
    checkTypedInput({
      fileName: "statement.pdf",
      kind: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
    });
  });

  test("rejects missing MIME metadata at the upload boundary", () => {
    expect(
      checkAttachmentLimits({
        fileName: "positions.csv",
        kind: "spreadsheet",
        mimeType: "",
        rowCount: 1,
        sizeBytes: 10,
      }),
    ).toMatchObject({ reason: "type", status: "out_of_limits" });
  });

  test("brands parsed data so raw structural objects cannot masquerade as validated", () => {
    const acceptValidated = (value: ReturnType<typeof extractedDocumentSchema.parse>) =>
      value;

    // @ts-expect-error Only schema parsing can create a validated extraction.
    acceptValidated({ documentType: "positions", positions: [], warnings: [] });
  });
});

describe("positions + movements document (PRD #1103 S4)", () => {
  const holding = (overrides: Record<string, unknown> = {}) => ({
    name: "Vanguard FTSE All-World",
    type: "Fondo indexado",
    value: "1.234,56",
    currency: "EUR",
    fidelity: "value_only" as const,
    ...overrides,
  });

  test("accepts a snapshot with no movements and normalizes Spanish numbers", () => {
    const parsed = positionsMovementsDocumentSchema.parse({
      documentType: "positions_movements",
      holdings: [holding()],
      movements: [],
      warnings: [],
    });

    expect(parsed.holdings[0]).toMatchObject({
      name: "Vanguard FTSE All-World",
      type: "Fondo indexado",
      value: 1234.56,
      currency: "EUR",
      fidelity: "value_only",
    });
    expect(parsed.movements).toEqual([]);
  });

  test("uppercases a valid ISIN and rejects a malformed one", () => {
    const parsed = extractedHoldingSchema.parse(holding({ isin: "ie00b3rbwm25" }));
    expect(parsed.isin).toBe("IE00B3RBWM25");

    expect(
      extractedHoldingSchema.safeParse(holding({ isin: "NOT-AN-ISIN" })).success,
    ).toBe(false);
  });

  test("rejects a movement that carries neither ISIN nor name to link on", () => {
    expect(
      extractedMovementSchema.safeParse({
        date: "2026-01-15",
        kind: "buy",
        amount: 500,
        currency: "EUR",
      }).success,
    ).toBe(false);

    expect(
      extractedMovementSchema.safeParse({
        date: "2026-01-15",
        kind: "buy",
        name: "Vanguard FTSE All-World",
        amount: 500,
        currency: "EUR",
      }).success,
    ).toBe(true);
  });

  test("rejects an unknown movement kind — the extractor never invents one", () => {
    expect(
      extractedMovementSchema.safeParse({
        date: "2026-01-15",
        kind: "rebalance",
        name: "Fondo",
        amount: 500,
        currency: "EUR",
      }).success,
    ).toBe(false);
  });

  describe("resolveHoldingFidelity — the honest cost-basis tier", () => {
    test("movements linked by ISIN win the real cost-basis tier", () => {
      expect(
        resolveHoldingFidelity(
          { isin: "IE00B3RBWM25", name: "Fondo", declaredCost: 1000 },
          [{ isin: "IE00B3RBWM25", name: undefined }],
        ),
      ).toBe("movements");
    });

    test("movements linked by name (case/space-insensitive) also win", () => {
      expect(
        resolveHoldingFidelity({ isin: undefined, name: "Banco  Santander" }, [
          { isin: undefined, name: "banco santander" },
        ]),
      ).toBe("movements");
    });

    test("a declared cost with no movements is the declared-cost tier", () => {
      expect(
        resolveHoldingFidelity({ isin: undefined, name: "Fondo", declaredCost: 900 }, []),
      ).toBe("declared_cost");
    });

    test("only a value, nothing else, is the honest value-only tier", () => {
      expect(resolveHoldingFidelity({ isin: undefined, name: "Fondo" }, [])).toBe(
        "value_only",
      );
    });

    test("a movement whose ISIN differs never links, even if names collide by luck", () => {
      // The invariant that keeps a coincidental match from forging a fake cost basis.
      expect(
        resolveHoldingFidelity({ isin: "IE00B3RBWM25", name: "Fondo" }, [
          { isin: "US0378331005", name: "Otra cosa" },
        ]),
      ).toBe("value_only");
    });
  });

  test("is a discriminated-union member the branded contract validates", () => {
    const parsed = extractedDocumentSchema.parse({
      documentType: "positions_movements",
      holdings: [holding({ fidelity: "movements", isin: "IE00B3RBWM25" })],
      movements: [
        {
          date: "2026-01-15",
          kind: "buy",
          isin: "IE00B3RBWM25",
          units: "10,5",
          amount: "1.000",
          currency: "EUR",
        },
      ],
      warnings: [],
    });
    expect(parsed.documentType).toBe("positions_movements");
  });
});
