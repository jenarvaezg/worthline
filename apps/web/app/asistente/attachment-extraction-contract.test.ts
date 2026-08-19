import { describe, expect, test } from "vitest";
import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  balanceSeriesDocumentSchema,
  brokerTransactionsDocumentSchema,
  checkAttachmentLimits,
  datedBalanceSchema,
  extractedDocumentSchema,
  extractedHoldingSchema,
  extractedMovementSchema,
  holdingEventDocumentSchema,
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

  /**
   * The reading that had no legal shape until this widening. MyInvestor's «Composición» tab
   * prints the fund's name and its value in euros — no símbolo, no participaciones — and
   * the vision model read it right; the contract then rejected every row and the capture
   * degraded to «no he podido leer ninguna fila», so the chat received neither the total
   * nor a single fund name.
   */
  test("accepts a value-only positions row: name + value + currency (#1325)", () => {
    const parsed = positionsDocumentSchema.parse({
      documentType: "positions",
      positions: [
        { currency: "EUR", marketValueEur: "574,48", name: "Fondo Índice Metal" },
        { currency: "EUR", marketValueEur: "839,15", name: "Fondo Índice Global" },
      ],
      totalEur: "1.413,63",
      warnings: ["La pantalla no imprime las participaciones de cada fondo."],
    });

    expect(parsed.positions.map((position) => position.marketValueEur)).toEqual([
      574.48, 839.15,
    ]);
    // Absent, never zero: a units of 0 next to a positive value would be a figure this
    // contract invented, and the alta bridge reads the absence as «by total value».
    expect(parsed.positions[0]?.units).toBeUndefined();
    expect(parsed.positions[0]?.ticker).toBeUndefined();
    expect(parsed.totalEur).toBe(1413.63);
  });

  test("takes a row that prints one of the two optional fields but not the other", () => {
    const parsed = positionsDocumentSchema.parse({
      documentType: "positions",
      positions: [
        { currency: "EUR", marketValueEur: 100, name: "Solo símbolo", ticker: "VWCE" },
        { currency: "EUR", marketValueEur: 200, name: "Solo unidades", units: "3" },
      ],
      warnings: [],
    });

    expect(parsed.positions[0]).toEqual({
      currency: "EUR",
      marketValueEur: 100,
      name: "Solo símbolo",
      ticker: "VWCE",
    });
    expect(parsed.positions[1]?.units).toBe(3);
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
    // The irreducible row is name + value + currency (#1325): `ticker` and `units` may
    // be absent because a composition tab prints neither, but a row with no NAME names
    // nothing, and one with no value carries no reading.
    {
      documentType: "positions",
      positions: [{ currency: "EUR", marketValueEur: 10, ticker: "NONAME", units: 1 }],
      warnings: [],
    },
    {
      documentType: "positions",
      positions: [{ currency: "EUR", name: "Sin valor", ticker: "NOVAL", units: 1 }],
      warnings: [],
    },
    // An EMPTY ticker is not «no ticker»: the seam drops the blank before the contract
    // sees it, so a blank arriving here means something upstream stopped cleaning.
    {
      documentType: "positions",
      positions: [
        { currency: "EUR", marketValueEur: 10, name: "Ticker en blanco", ticker: "  " },
      ],
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

  /**
   * The `unrecognized` discriminant (#1246). It exists because behaviour branches on
   * WHICH of the two facts the status carries — only «no document identified» cascades
   * into a descriptive reading — and a comparison against a message literal would tie
   * that branch to user-facing copy.
   */
  describe("unrecognized reason discriminant (#1246)", () => {
    test.each([
      "unidentified_document",
      "empty_reading",
    ] as const)("preserves the closed %s reason", (reason) => {
      const result = parseExtractionResult({
        message: "Nada extraído.",
        reason,
        status: "unrecognized",
      });
      expect(result).toEqual({
        message: "Nada extraído.",
        reason,
        status: "unrecognized",
      });
    });

    test("still accepts an unrecognized envelope with no reason at all", () => {
      // Previews already sitting in a client history predate the field, and
      // `parseAttachmentPreviewData` revalidates them on every turn.
      expect(
        parseExtractionResult({ message: "Nada extraído.", status: "unrecognized" }),
      ).toEqual({ message: "Nada extraído.", status: "unrecognized" });
    });

    test("refuses a reason outside the closed vocabulary", () => {
      expect(
        parseExtractionResult({
          message: "Nada extraído.",
          reason: "porque_yo_lo_digo",
          status: "unrecognized",
        }).status,
      ).toBe("failure");
    });
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

describe("holding_event document", () => {
  /** The capture that originated PRD #1241: Revolut «Detalles del pago». */
  const originCapture = {
    documentType: "holding_event",
    event: {
      date: "2026-07-26",
      amount: "91,32",
      currency: "EUR",
      label: "Amortización anticipada",
      kind: "early_repayment",
      declaredEffect: {
        kind: "final_instalment_reduced",
        amount: "110,64",
        currency: "EUR",
      },
      nextInstalment: { date: "2026-08-08", amount: "158,49", currency: "EUR" },
    },
    warnings: [],
  };

  test("reads the origin capture as one dated fact, verbatim label included", () => {
    const parsed = holdingEventDocumentSchema.parse(originCapture);

    expect(parsed.event).toEqual({
      date: "2026-07-26",
      amount: 91.32,
      currency: "EUR",
      label: "Amortización anticipada",
      kind: "early_repayment",
      declaredEffect: {
        kind: "final_instalment_reduced",
        amount: 110.64,
        currency: "EUR",
      },
      nextInstalment: { date: "2026-08-08", amount: 158.49, currency: "EUR" },
    });
  });

  test("is a discriminated-union member the branded contract validates", () => {
    const parsed = extractedDocumentSchema.parse(originCapture);
    expect(parsed.documentType).toBe("holding_event");
  });

  test("carries ONE event and no array, so the validated door cannot pass a bulk import", () => {
    // The lock decided before this contract was written (#1244): a validated
    // document exempts the turn from the unvalidated-evidence gate AND its
    // one-proposal cap (#1248), so twelve events behind that door would be twelve
    // proposals through the lane nobody measures. There is no array to count.
    expect("events" in holdingEventDocumentSchema.shape).toBe(false);
    // A list rejected for the reason that matters — the extra key — and not merely
    // because `event` went missing alongside it.
    expect(
      extractedDocumentSchema.safeParse({
        ...originCapture,
        events: [originCapture.event],
      }).success,
    ).toBe(false);
  });

  test.each([
    ["capital", { principal: 4200 }],
    ["plazo", { termMonths: 24 }],
    ["tipo de interés", { interestRate: 5.9 }],
    ["saldo resultante", { balanceAfter: 4108.68 }],
    ["el holding al que pertenece", { holdingId: "h_123" }],
  ])("rejects an inferred %s riding along on the event (ADR 0048)", (_label, extra) => {
    expect(
      extractedDocumentSchema.safeParse({
        ...originCapture,
        event: { ...originCapture.event, ...extra },
      }).success,
    ).toBe(false);
  });

  test.each([
    // No date: a dated fact without its date is not one.
    ["no date", { date: undefined }],
    // Free-form date instead of a real day — never an invented one.
    ["a free-form date", { date: "8 de agosto" }],
    // Impossible calendar day.
    ["an impossible day", { date: "2026-02-30" }],
    // No amount.
    ["no amount", { amount: undefined }],
    // Unreadable amount.
    ["an unreadable amount", { amount: "no consta" }],
    // No currency, or one that is not an ISO code.
    ["no currency", { currency: undefined }],
    ["a currency that is not ISO", { currency: "euros" }],
    // A kind outside the closed enum.
    ["a kind outside the enum", { kind: "amortizacion" }],
    // An empty verbatim label.
    ["an empty label", { label: "   " }],
    // A label past the contract's string cap.
    ["a label past the cap", { label: "x".repeat(301) }],
  ])("rejects an event with %s", (_case, patch) => {
    expect(
      extractedDocumentSchema.safeParse({
        ...originCapture,
        event: { ...originCapture.event, ...patch },
      }).success,
    ).toBe(false);
  });

  test("keeps the declared effect a closed enum, never free text", () => {
    expect(
      holdingEventDocumentSchema.safeParse({
        ...originCapture,
        event: {
          ...originCapture.event,
          declaredEffect: { kind: "te bajamos la última cuota" },
        },
      }).success,
    ).toBe(false);
  });

  test("refuses a declared effect amount with no currency to read it in", () => {
    const withoutCurrency = holdingEventDocumentSchema.safeParse({
      ...originCapture,
      event: {
        ...originCapture.event,
        declaredEffect: { kind: "balance_reduced", amount: 110.64 },
      },
    });
    expect(withoutCurrency.success).toBe(false);

    // The effect with no figure at all is honest and stays legal: the screen said
    // what it does without saying by how much.
    expect(
      holdingEventDocumentSchema.safeParse({
        ...originCapture,
        event: { ...originCapture.event, declaredEffect: { kind: "term_shortened" } },
      }).success,
    ).toBe(true);
  });

  test("accepts the bare observation: only the enum fields the screen showed", () => {
    const parsed = holdingEventDocumentSchema.parse({
      documentType: "holding_event",
      event: {
        date: "2026-07-08",
        amount: 158.49,
        currency: "EUR",
        label: "Cuota mensual",
        kind: "payment",
        uncertain: true,
      },
      uncertain: true,
      warnings: ["El importe estaba parcialmente tapado."],
    });

    expect(parsed.event.declaredEffect).toBeUndefined();
    expect(parsed.event.nextInstalment).toBeUndefined();
    // The trade-confirmation fields (#1316) are optional in the same way: an event
    // that prints none of them is unchanged by their existence.
    expect(parsed.event.isin).toBeUndefined();
    expect(parsed.event.units).toBeUndefined();
    expect(parsed.event.pricePerUnit).toBeUndefined();
    expect(parsed.event.fees).toBeUndefined();
    expect(parsed.event.uncertain).toBe(true);
    expect(parsed.uncertain).toBe(true);
  });

  describe("the securities trade confirmation (#1316)", () => {
    /** A MyInvestor buy confirmation: ISIN, títulos, precio bruto and comisión. */
    const tradeConfirmation = {
      documentType: "holding_event",
      event: {
        date: "2026-07-24",
        amount: "1.004,60",
        currency: "EUR",
        label: "Compra VANGUARD GLOBAL STOCK INDEX FUND",
        kind: "other",
        isin: "IE00B03HCZ61",
        units: "62,3418",
        pricePerUnit: { amount: "16,0184", currency: "EUR" },
        fees: { amount: "1,50", currency: "EUR" },
      },
      warnings: [],
    };

    test("reads the instrument identity the paper printed, nothing derived", () => {
      const parsed = holdingEventDocumentSchema.parse(tradeConfirmation);

      expect(parsed.event).toEqual({
        date: "2026-07-24",
        amount: 1004.6,
        currency: "EUR",
        label: "Compra VANGUARD GLOBAL STOCK INDEX FUND",
        kind: "other",
        isin: "IE00B03HCZ61",
        units: 62.3418,
        pricePerUnit: { amount: 16.0184, currency: "EUR" },
        fees: { amount: 1.5, currency: "EUR" },
      });
    });

    test("uppercases the ISIN and rejects anything that is not one", () => {
      const lowercase = holdingEventDocumentSchema.parse({
        ...tradeConfirmation,
        event: { ...tradeConfirmation.event, isin: "ie00b03hcz61" },
      });
      expect(lowercase.event.isin).toBe("IE00B03HCZ61");

      // A ticker, a fund name or a truncated code can never masquerade as an ISIN —
      // it would travel to `propose_holding` as an identity nobody verified.
      for (const notAnIsin of ["VWCE", "IE00B03HCZ6", "IE00B03HCZ611", "IE00B03HCZ6X"]) {
        expect(
          holdingEventDocumentSchema.safeParse({
            ...tradeConfirmation,
            event: { ...tradeConfirmation.event, isin: notAnIsin },
          }).success,
        ).toBe(false);
      }
    });

    test.each([
      ["a price with no currency", { pricePerUnit: { amount: 16.0184 } }],
      ["a price with no amount", { pricePerUnit: { currency: "EUR" } }],
      ["a fee with no currency", { fees: { amount: 1.5 } }],
      ["a fee with no amount", { fees: { currency: "EUR" } }],
      ["an unreadable number of units", { units: "no consta" }],
      ["a fee that is not a number", { fees: { amount: "gratis", currency: "EUR" } }],
      // The derivation the extractor may never do, spelled as a field: the total is
      // `amount`, and a second one computed from units × price is not observed.
      ["a computed gross amount", { grossAmount: 998.6 }],
    ])("rejects %s", (_case, patch) => {
      expect(
        extractedDocumentSchema.safeParse({
          ...tradeConfirmation,
          event: { ...tradeConfirmation.event, ...patch },
        }).success,
      ).toBe(false);
    });

    test("takes the trade figures in a currency of their own", () => {
      // A confirmation that settles in EUR may still print the price in the market's
      // currency. Each pair carries its own code precisely so neither is assumed.
      const parsed = holdingEventDocumentSchema.parse({
        ...tradeConfirmation,
        event: {
          ...tradeConfirmation.event,
          pricePerUnit: { amount: 18.42, currency: "USD" },
        },
      });
      expect(parsed.event.pricePerUnit).toEqual({ amount: 18.42, currency: "USD" });
      expect(parsed.event.currency).toBe("EUR");
    });
  });

  test("caps warnings exactly like every other document", () => {
    const overCap = Array.from(
      { length: ATTACHMENT_EXTRACTION_LIMITS_V1.maxWarnings + 1 },
      (_value, index) => `Aviso ${index}`,
    );
    expect(
      holdingEventDocumentSchema.safeParse({ ...originCapture, warnings: overCap })
        .success,
    ).toBe(false);
    expect(
      holdingEventDocumentSchema.safeParse({
        ...originCapture,
        warnings: overCap.slice(0, -1),
      }).success,
    ).toBe(true);
  });

  test("survives parseExtractionResult, the seam every extractor route shares", () => {
    const result = parseExtractionResult({ data: originCapture, status: "valid" });
    // Narrowed by THROWING, never by an `if` that would let the assertions below be
    // skipped in silence and still score the test green.
    if (result.status !== "valid") throw new Error(`got ${result.status}`);
    if (result.data.documentType !== "holding_event") {
      throw new Error(`got ${result.data.documentType}`);
    }
    expect(result.data.event.amount).toBe(91.32);
    expect(result.data.event.declaredEffect?.kind).toBe("final_instalment_reduced");
  });
});

/**
 * The broker transactions ledger (#1487). Its magnitudes are DECIMAL STRINGS and not
 * JSON numbers, so the contract's job here is to keep an exact reading exact.
 */
describe("brokerTransactionsDocumentSchema", () => {
  const TRADE = {
    amount: "562.44",
    currency: "EUR",
    date: "2026-02-12",
    feesMinor: 100,
    isin: "IE00B5BMR087",
    kind: "buy",
    name: "ISHARES CORE S&P 500",
    pricePerUnit: "187.48",
    units: "3",
  };

  test("accepts a ledger of trades and keeps its figures as written", () => {
    const parsed = brokerTransactionsDocumentSchema.safeParse({
      documentType: "broker_transactions",
      transactions: [TRADE],
      warnings: [],
    });
    if (!parsed.success) throw new Error("expected a valid ledger");
    expect(parsed.data.transactions[0]?.units).toBe("3");
    expect(parsed.data.transactions[0]?.amount).toBe("562.44");
  });

  test("keeps an eight-decimal quantity out of exponential notation", () => {
    const parsed = brokerTransactionsDocumentSchema.safeParse({
      documentType: "broker_transactions",
      transactions: [{ ...TRADE, pricePerUnit: "56244000000", units: "0.00000001" }],
      warnings: [],
    });
    if (!parsed.success) throw new Error("expected a valid ledger");
    // `String(1e-8)` is «1e-8», which the schema refuses — so an already-canonical
    // string must never be re-rendered through a float on its way in.
    expect(parsed.data.transactions[0]?.units).toBe("0.00000001");
  });

  test("reads a Spanish figure and a JSON number into the same canonical string", () => {
    const parsed = brokerTransactionsDocumentSchema.safeParse({
      documentType: "broker_transactions",
      transactions: [{ ...TRADE, amount: "1.234,56", units: 3 }],
      warnings: [],
    });
    if (!parsed.success) throw new Error("expected a valid ledger");
    expect(parsed.data.transactions[0]?.amount).toBe("1234.56");
    expect(parsed.data.transactions[0]?.units).toBe("3");
  });

  test("refuses a signed or zero magnitude, and a row with no instrument key", () => {
    const withoutKey = { ...TRADE, isin: undefined, name: undefined };
    for (const transaction of [
      { ...TRADE, units: "-3" },
      { ...TRADE, amount: "0" },
      withoutKey,
    ]) {
      expect(
        brokerTransactionsDocumentSchema.safeParse({
          documentType: "broker_transactions",
          transactions: [transaction],
          warnings: [],
        }).success,
      ).toBe(false);
    }
  });
});
