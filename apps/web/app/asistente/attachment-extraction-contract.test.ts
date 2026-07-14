import { describe, expect, test } from "vitest";
import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  checkAttachmentLimits,
  extractedPositionsSchema,
  normalizeExtractedNumber,
  parseExtractionResult,
} from "./attachment-extraction-contract";

describe("attachment extraction contract", () => {
  test("normalizes Spanish financial numbers without reading them as Anglo decimals", () => {
    expect(normalizeExtractedNumber("1.234,56")).toBe(1234.56);
    expect(normalizeExtractedNumber("1234.56")).toBe(1234.56);
    expect(normalizeExtractedNumber(1234.56)).toBe(1234.56);
    expect(normalizeExtractedNumber("not a number")).toBeNull();
  });

  test("accepts and normalizes a complete positions extraction", () => {
    const parsed = extractedPositionsSchema.parse({
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

  test("preserves visible uncertainty and warnings", () => {
    const parsed = extractedPositionsSchema.parse({
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
    { positions: [], warnings: [] },
    {
      positions: [{ currency: "EUR", marketValueEur: 10, name: "Incomplete", units: 1 }],
      warnings: [],
    },
    {
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
  ])("rejects malformed or partial extraction %#", (raw) => {
    expect(extractedPositionsSchema.safeParse(raw).success).toBe(false);
  });

  test("turns a malformed valid result into a definitive extractor failure", () => {
    expect(
      parseExtractionResult({
        data: {
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
        message: "La hoja supera el límite de filas.",
        reason: "rows",
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

  test("accepts every v1 attachment family at the exact size and row boundaries", () => {
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
      expected: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV o XLSX.",
      input: {
        fileName: "statement.pdf",
        kind: "image" as const,
        mimeType: "application/pdf",
        sizeBytes: 10,
      },
      reason: "type",
    },
    {
      expected: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV o XLSX.",
      input: {
        fileName: "statement.pdf",
        kind: "image" as const,
        mimeType: "image/png",
        sizeBytes: 10,
      },
      reason: "type",
    },
    {
      expected: "Solo se admiten archivos PNG, JPEG, WebP, HEIC/HEIF, CSV o XLSX.",
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
  ])("returns a comprehensible $reason limit result", ({ expected, input, reason }) => {
    expect(checkAttachmentLimits(input)).toEqual({
      message: expected,
      reason,
      status: "out_of_limits",
    });
  });

  test("requires spreadsheet row counts at the typed limit seam", () => {
    const checkTypedInput = (input: Parameters<typeof checkAttachmentLimits>[0]) => input;

    // @ts-expect-error Spreadsheet inputs cannot omit the row count.
    checkTypedInput({
      fileName: "positions.csv",
      kind: "spreadsheet",
      mimeType: "text/csv",
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
    const acceptValidated = (value: ReturnType<typeof extractedPositionsSchema.parse>) =>
      value;

    // @ts-expect-error Only schema parsing can create a validated extraction.
    acceptValidated({ positions: [], warnings: [] });
  });
});
