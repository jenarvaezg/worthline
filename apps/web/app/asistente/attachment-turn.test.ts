import { hasUnstructuredEvidenceInHistory } from "@web/asistente/attachment-chat";
import {
  ATTACHMENT_EXTRACTION_LIMITS_V1,
  type AttachmentExtractionResult,
  parseExtractionResult,
} from "@web/asistente/attachment-extraction-contract";
import {
  UNIDENTIFIED_DOCUMENT_MESSAGE,
  UNSTRUCTURED_EMPTY_READING_MESSAGE,
  UNSTRUCTURED_SPREADSHEET_MESSAGE,
  UNSTRUCTURED_VISION_MESSAGE,
} from "@web/asistente/attachment-types";
import { describeVisionAttachment } from "@web/asistente/attachment-vision-description";
import { extractDocumentFromVisionAttachment } from "@web/asistente/attachment-vision-extractor";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AttachmentTurnInput,
  isVisionAttachment,
  readAttachmentTurn,
} from "./attachment-turn";

vi.mock("@web/asistente/attachment-vision-extractor", () => ({
  extractDocumentFromVisionAttachment: vi.fn(),
}));
vi.mock("@web/asistente/attachment-vision-description", () => ({
  describeVisionAttachment: vi.fn(),
}));

/**
 * What the vision seam hands back since #1345: the verdict, plus the number of vision
 * calls it charged. The policy behind that number lives — and is graded — in the seam;
 * what this file grades is that the turn carries it through and adds its own cascade.
 */
function visionReading(
  result: AttachmentExtractionResult,
  visionCalls = 1,
): { result: AttachmentExtractionResult; visionCalls: number } {
  return { result, visionCalls };
}

/**
 * The turn's own date (#1424). Fixed rather than `new Date()` so the fixtures below
 * sit on a known side of the observed/forecast line — the whole point of the mark is
 * that it depends on today, and a test whose today drifts grades a different document
 * every morning.
 */
const TODAY = "2026-08-17";

function csv(text: string): AttachmentTurnInput {
  return {
    bytes: new TextEncoder().encode(text),
    fileName: "hoja.csv",
    mimeType: "text/csv",
    today: TODAY,
  };
}

/**
 * A cuadro de amortización as it really reads: past instalments and the bank's
 * projection under one header, with nothing in the sheet telling them apart. The
 * currency column is explicit so the reading's only warning is the one under test.
 */
const SCHEDULE_CSV = [
  "Fecha;Capital pendiente;Divisa",
  "2026-06-01;52857,24;EUR",
  "2027-06-01;46985,97;EUR",
  "2034-06-01;0,01;EUR",
].join("\n");

const PAST_BALANCES_CSV = [
  "Fecha;Capital pendiente;Divisa",
  "2026-05-01;53000,00;EUR",
  "2026-06-01;52857,24;EUR",
].join("\n");

/** The validated balance series behind a card, or a loud failure saying it was not one. */
function balanceSeriesOf(preview: { result: AttachmentExtractionResult }) {
  const { result } = preview;
  if (result.status !== "valid" || result.data.documentType !== "balance_series") {
    throw new Error(`Expected a balance series, got ${result.status}`);
  }
  return result.data;
}

const POSITIONS_CSV = [
  "Símbolo;Nombre;Unidades;Valor de mercado EUR;Divisa",
  "VWCE;Vanguard FTSE All-World;120;13450,32;EUR",
].join("\n");

/**
 * A readable sheet that is NO document the deterministic route knows. It used to be
 * `Concepto;Saldo;Fecha` — a dated balance, which is exactly the document the sheet
 * lane learned to validate in #1417, so it stopped being an example of this lane.
 * Notes against names is the shape that still has nothing to extract.
 */
const NOT_A_KNOWN_DOCUMENT_CSV = [
  "Concepto;Notas",
  "Cuenta corriente conjunta;pendiente de revisar con el banco",
].join("\n");

/**
 * The cuadro de amortización the #1419 workbook test used to attach (#1429), as a
 * generator: `SCHEDULE_DAYS` distinct dates, each repeated as many times as the row
 * count divides into them. A synthetic shape, but the two facts it carries are the
 * real ones — a schedule is long, and a real one repeats a date whenever something
 * happened twice that day.
 */
const SCHEDULE_DAYS = 9;

function scheduleCsv(rowCount: number): string {
  return [
    "Cuota;Fecha;Capital;Interés;Saldo",
    ...Array.from(
      { length: rowCount },
      (_unused, index) =>
        `Cuota ${index + 1};01/0${(index % SCHEDULE_DAYS) + 1}/2020;300,00;120,00;${200_000 - index * 100},00`,
    ),
  ].join("\n");
}

beforeEach(() => {
  vi.mocked(extractDocumentFromVisionAttachment).mockReset();
  vi.mocked(describeVisionAttachment).mockReset();
});

describe("isVisionAttachment", () => {
  it("separates the lanes the money fuse must not confuse", () => {
    // The gate in the route keys on this: a spreadsheet costs nothing, so braking
    // one on a spent allowance would refuse a free upload (#1258).
    expect(isVisionAttachment({ fileName: "captura.png", mimeType: "image/png" })).toBe(
      true,
    );
    expect(
      isVisionAttachment({ fileName: "extracto.pdf", mimeType: "application/pdf" }),
    ).toBe(true);
    // Same extension-only fallback the reading itself uses, so the two agree.
    expect(isVisionAttachment({ fileName: " extracto.PDF ", mimeType: "" })).toBe(true);
    expect(isVisionAttachment({ fileName: "hoja.csv", mimeType: "text/csv" })).toBe(
      false,
    );
  });
});

describe("readAttachmentTurn", () => {
  it("validates a positions spreadsheet without any model call", async () => {
    const reading = await readAttachmentTurn(csv(POSITIONS_CSV));

    expect(reading.preview.result.status).toBe("valid");
    expect(reading.unstructured).toBeNull();
    expect(extractDocumentFromVisionAttachment).not.toHaveBeenCalled();
  });

  it("hands a readable-but-unrecognized sheet over as unstructured context", async () => {
    const reading = await readAttachmentTurn(csv(NOT_A_KNOWN_DOCUMENT_CSV));

    expect(reading.preview.result).toEqual({
      message: UNSTRUCTURED_SPREADSHEET_MESSAGE,
      status: "unrecognized",
    });
    expect(reading.unstructured?.source).toBe("spreadsheet_grid");
    expect(reading.unstructured?.fitTo(200_000).text).toContain(
      "Cuenta corriente conjunta",
    );
    // A workbook never reaches a vision model: the deterministic route owns it.
    expect(extractDocumentFromVisionAttachment).not.toHaveBeenCalled();
    expect(describeVisionAttachment).not.toHaveBeenCalled();
  });

  it("marks the forecast half of an amortization schedule read from a sheet", async () => {
    // El caso de Jorge (#1424): cuatro de los saldos de su cuadro están fechados
    // después de hoy. El extractor no puede saberlo —la frontera es la fecha del
    // turno, que no está en el documento— así que la estampa este seam.
    const reading = await readAttachmentTurn(csv(SCHEDULE_CSV));

    expect(reading.preview.result.status).toBe("valid");
    const data = balanceSeriesOf(reading.preview);
    expect(data.balances.map((balance) => balance.projected)).toEqual([
      undefined,
      true,
      true,
    ]);
    expect(data.warnings[0]).toContain("2 de los 3 saldos son posteriores a hoy");
  });

  it("marks the same document read through the vision lane", async () => {
    // La asimetría que #1417 ya tuvo que quitar una vez: el MISMO cuadro no puede
    // significar una cosa en .xlsx y otra en PDF.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading(
        parseExtractionResult({
          data: {
            balances: [
              { amount: 52857.24, currency: "EUR", date: "2026-06-01" },
              { amount: 46985.97, currency: "EUR", date: "2027-06-01" },
            ],
            documentType: "balance_series",
            warnings: [],
          },
          status: "valid",
        }),
      ),
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "cuadro.pdf",
      mimeType: "application/pdf",
      today: TODAY,
    });

    expect(balanceSeriesOf(reading.preview).balances.map((b) => b.projected)).toEqual([
      undefined,
      true,
    ]);
  });

  it("leaves a fully observed statement unmarked and unwarned", async () => {
    const reading = await readAttachmentTurn(csv(PAST_BALANCES_CSV));

    const data = balanceSeriesOf(reading.preview);
    expect(data.balances.every((balance) => balance.projected === undefined)).toBe(true);
    expect(data.warnings).toEqual([]);
  });

  /**
   * Which lane a BIG amortization schedule travels in (#1429). The question is not
   * academic: the workbook lane's own test used to attach exactly this file, and
   * #1417 quietly moved it — the sheet extractor learned to read `Fecha` + `Saldo`,
   * so the model stopped receiving the grid and started receiving the reading.
   *
   * That is the answer we want, and this pins it: a long schedule is the document
   * worthline knows how to type, and typed beats described.
   */
  it("types a 450-row schedule instead of handing over the workbook (#1429)", async () => {
    const reading = await readAttachmentTurn(csv(scheduleCsv(450)));

    // The typed lane, all the way: no grid travels alongside the reading, so the
    // unvalidated-evidence gate (#1248) is NOT opened by a document we did read.
    expect(reading.unstructured).toBeNull();
    const data = balanceSeriesOf(reading.preview);
    expect(data.balances).toHaveLength(450);
    // «Cuota» and «Capital» are the instalment and the principal PAID, never the
    // outstanding balance: the reading comes off the `Saldo` column alone.
    expect(data.balances[0]).toMatchObject({ amount: 200_000, date: "2020-01-01" });
    expect(data.balances.at(-1)).toMatchObject({ amount: 155_100, date: "2020-09-01" });
    // Nine days, 450 observations: what the sheet says is a same-day repetition 441
    // times over, and the reading hands all of them on rather than folding any — the
    // folding is the import plan's job, and it needs to see the repetition to do it.
    expect(new Set(data.balances.map((balance) => balance.date)).size).toBe(
      SCHEDULE_DAYS,
    );
    // The sheet prints no currency, so the ONE assumption is stated on the card.
    expect(data.uncertain).toBe(true);
    expect(data.warnings.join(" ")).toContain("no indica la divisa");
    expect(extractDocumentFromVisionAttachment).not.toHaveBeenCalled();
  });

  /**
   * Where «grande» stops being a size and becomes a cliff (#1429).
   *
   * What bounds this document is the number of OBSERVATIONS, not the height of the
   * sheet — the balance-series extractor measures `balances.length` on purpose, so a
   * 40-year schedule of 480 monthly rows carrying a few dozen printed balances passes
   * comfortably. But a bank that prints the balance on EVERY row hits the contract's
   * `maxRows`, and past it the verdict is `out_of_limits`, which is not
   * `unrecognized`: the workbook lane only catches the second, so an oversized
   * schedule takes NEITHER lane and the model is left with the verdict alone.
   *
   * That is today's answer and it is worth having in writing, because it is the
   * opposite of the one #865 gives for a sheet we cannot type — that one at least
   * gets described. Whether the typed lane should fall back to the grid when the
   * reading is merely too long is a decision, not an oversight, and it is not this
   * issue's to take; what this test guarantees is that changing it is deliberate.
   */
  it("leaves an over-long schedule with no lane at all, on purpose (#1429)", async () => {
    const maxRows = ATTACHMENT_EXTRACTION_LIMITS_V1.maxRows;

    const atTheLimit = await readAttachmentTurn(csv(scheduleCsv(maxRows)));
    expect(atTheLimit.preview.result.status).toBe("valid");

    const overIt = await readAttachmentTurn(csv(scheduleCsv(maxRows + 1)));
    expect(overIt.preview.result).toMatchObject({
      reason: "rows",
      status: "out_of_limits",
    });
    // Not `unrecognized`, so `readSpreadsheetContext` never runs: no grid, no
    // description, nothing but the card.
    expect(overIt.unstructured).toBeNull();
  });

  it("trims the user-supplied file name once, here", async () => {
    const reading = await readAttachmentTurn({
      ...csv(POSITIONS_CSV),
      fileName: "  hoja.csv  ",
      today: TODAY,
    });

    expect(reading.preview.fileName).toBe("hoja.csv");
  });

  it("describes a capture whose document the seam did not identify", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "no lo reconozco",
        reason: "unidentified_document",
        status: "unrecognized",
      }),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue("Se ve una pantalla de pago.");

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.unstructured?.fitTo(200_000)).toEqual({
      fileName: "captura.png",
      source: "vision_description",
      text: "Se ve una pantalla de pago.",
    });
    expect(reading.preview.result).toMatchObject({
      reason: "unidentified_document",
      status: "unrecognized",
    });
    expect(
      vi.mocked(extractDocumentFromVisionAttachment).mock.calls[0]?.[0],
    ).toMatchObject({ kind: "image" });
  });

  it("sends a screen of several dated facts down the descriptive lane (#1244)", async () => {
    // The safety argument behind the holding-event lock, pinned end to end. A screen
    // carrying more than one dated fact is declined rather than validated, precisely
    // so it does NOT lift the unvalidated-evidence gate and its one-proposal cap
    // (#1248) — and the verdict it is declined with has to be the one this drain
    // branches on, or the capture dies on the card instead of being discussed.
    //
    // The two constants are the coupling: `unidentifiedDocument` in the extractor
    // returns exactly this envelope, and `readAttachmentTurn` keys off `reason`.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: UNIDENTIFIED_DOCUMENT_MESSAGE,
        reason: "unidentified_document",
        status: "unrecognized",
      }),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue(
      "Se ven doce apuntes con fecha e importe.",
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "movimientos.png",
      mimeType: "image/png",
      today: TODAY,
    });

    // Unstructured, NOT validated: this is what keeps the gate and the cap biting.
    expect(reading.unstructured?.source).toBe("vision_description");
    // And the card carries the message `hasUnstructuredEvidenceInHistory` looks for,
    // so the boundary still recognizes this turn one turn later (#1246). Asserting
    // merely «not valid» would pass with a card the history lane cannot see.
    expect(reading.preview.result).toMatchObject({
      message: UNSTRUCTURED_VISION_MESSAGE,
      status: "unrecognized",
    });
  });

  it("describes a document it DID identify and could not read a row of (#1246)", async () => {
    // The regression, from the real capture: MyInvestor's «Composición» tab came back
    // `empty_reading` and the turn reached the model with nothing at all — not the total
    // printed at the top of the screen, not one fund name. «Describing it would be
    // paraphrasing» was the argument for skipping the drain, and it was backwards: a
    // reading that failed is exactly the one with everything left to describe.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "no he podido leer ninguna fila",
        reason: "empty_reading",
        status: "unrecognized",
      }),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue(
      "Se ve una cartera con dos fondos y un total de 1.413,63 €.",
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "composicion.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.unstructured?.fitTo(200_000)).toEqual({
      fileName: "composicion.png",
      source: "vision_description",
      text: "Se ve una cartera con dos fondos y un total de 1.413,63 €.",
    });
    // Its own card, and its own verdict: claiming «no reconozco ningún documento» would
    // deny the one thing the seam DID manage to do.
    expect(reading.preview.result).toEqual({
      message: UNSTRUCTURED_EMPTY_READING_MESSAGE,
      reason: "empty_reading",
      status: "unrecognized",
    });
    expect(UNSTRUCTURED_EMPTY_READING_MESSAGE).not.toBe(UNSTRUCTURED_VISION_MESSAGE);
  });

  it("keeps the described empty reading visible to the #1248 history boundary", () => {
    // The coupling that makes the new lane safe: the card it writes has to be a marker
    // `hasUnstructuredEvidenceInHistory` recognizes, or the unvalidated-evidence gate
    // fails OPEN one turn later for a conversation that already has evidence on it.
    expect(
      hasUnstructuredEvidenceInHistory([
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "data-attachment-extraction",
              data: {
                fileName: "composicion.png",
                result: {
                  message: UNSTRUCTURED_EMPTY_READING_MESSAGE,
                  reason: "empty_reading",
                  status: "unrecognized",
                },
              },
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("charges the second call the new drain adds (#1258 stays coherent)", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "no he podido leer ninguna fila",
        reason: "empty_reading",
        status: "unrecognized",
      }),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue("Se ve una cartera.");

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "composicion.png",
      mimeType: "image/png",
      today: TODAY,
    });

    // Two calls, counted on the ASK exactly as the unidentified lane counts them: the
    // content this buys is not free, and the fuse must see what it cost.
    expect(reading.visionCalls).toBe(2);
  });

  it("still describes nothing when the verdict carries no reason at all", async () => {
    // Only the vision seam stamps the discriminant. A route that cannot say which of the
    // two facts held cannot say a description would help either, and a workbook must
    // never reach a vision model (it would clobber its own rendered grid).
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "nada",
        status: "unrecognized",
      }),
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.unstructured).toBeNull();
    expect(describeVisionAttachment).not.toHaveBeenCalled();
    expect(reading.visionCalls).toBe(1);
  });

  it("leaves the extractor's own verdict standing when nothing describes the capture", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "no lo reconozco",
        reason: "unidentified_document",
        status: "unrecognized",
      }),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue(null);

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.unstructured).toBeNull();
    expect(reading.preview.result).toMatchObject({ message: "no lo reconozco" });
  });

  it("routes a PDF through the same vision seam as a picture", async () => {
    // The MIME type picks the transport only (#1243): one seam identifies the document
    // behind an image or a PDF by its content.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "nada",
        status: "unrecognized",
      }),
    );

    await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "extracto.pdf",
      mimeType: "application/pdf",
      today: TODAY,
    });

    expect(
      vi.mocked(extractDocumentFromVisionAttachment).mock.calls[0]?.[0],
    ).toMatchObject({ kind: "pdf" });
  });

  it("charges nothing for the deterministic spreadsheet route", async () => {
    // The seam's report is what the money fuse counts (#1258), so «no model was
    // called» has to arrive as a zero, not as an absent field.
    expect((await readAttachmentTurn(csv(POSITIONS_CSV))).visionCalls).toBe(0);
    expect((await readAttachmentTurn(csv(NOT_A_KNOWN_DOCUMENT_CSV))).visionCalls).toBe(0);
  });

  it.each([1, 2])("carries the %i call(s) the seam says it made", async (calls) => {
    // The seam owns the number now (#1345): a `holding_event` costs two calls and every
    // other identified document one, and the turn cannot tell them apart from the
    // verdict — the card is identical. Deriving it here would under-count the branch
    // that spends the most, which is the direction that stops a fuse from holding.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading(
        parseExtractionResult({
          data: {
            documentType: "holding_event",
            event: {
              amount: 91.32,
              currency: "EUR",
              date: "2026-07-26",
              kind: "payment",
              label: "Cuota de julio",
            },
            warnings: [],
          },
          status: "valid",
        }),
        calls,
      ),
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.visionCalls).toBe(calls);
    expect(describeVisionAttachment).not.toHaveBeenCalled();
  });

  it("adds the descriptive call on top of a detail read that was declined", async () => {
    // The worst case, and the reason it is worth stating out loud: a screen typed as a
    // dated fact, read in detail, and then declined pays for three vision calls. The
    // alternative is the dead end PRD #1241 opened against, so it is a price, not a bug.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading(
        {
          message: UNIDENTIFIED_DOCUMENT_MESSAGE,
          reason: "unidentified_document",
          status: "unrecognized",
        },
        2,
      ),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue("Se ve una pantalla de pago.");

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.visionCalls).toBe(3);
    expect(reading.unstructured?.source).toBe("vision_description");
  });

  it("charges TWO calls for the descriptive cascade — the cost #1246 added", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "no lo reconozco",
        reason: "unidentified_document",
        status: "unrecognized",
      }),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue("Se ve una pantalla de pago.");

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.visionCalls).toBe(2);
  });

  it("still charges the description the provider never answered", async () => {
    // The request was made. Counting only successful answers would hand an abuser a
    // free lane precisely when the provider is struggling.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "no lo reconozco",
        reason: "unidentified_document",
        status: "unrecognized",
      }),
    );
    vi.mocked(describeVisionAttachment).mockResolvedValue(null);

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.visionCalls).toBe(2);
  });

  it("charges nothing for a «PDF» whose bytes are not a PDF", async () => {
    // Decided by `looksLikePdf` over bytes already in memory, before the API key is
    // even read. Charging it would let a caller burn their allowance for free.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading(
        {
          code: "unsupported_document",
          failure: "permanent",
          message: "El archivo no es un PDF legible.",
          status: "failure",
        },
        0,
      ),
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "extracto.pdf",
      mimeType: "application/pdf",
      today: TODAY,
    });

    expect(reading.visionCalls).toBe(0);
  });

  it("charges nothing for a file the contract refused before any provider", async () => {
    // An oversized upload is decided over bytes already in memory. Charging it would
    // let a user burn their own daily allowance on files no model ever saw.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading(
        {
          message: "El archivo es demasiado grande.",
          reason: "size",
          status: "out_of_limits",
        },
        0,
      ),
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "enorme.png",
      mimeType: "image/png",
      today: TODAY,
    });

    expect(reading.visionCalls).toBe(0);
    expect(describeVisionAttachment).not.toHaveBeenCalled();
  });

  it("treats a PDF by extension even when the browser sends no MIME type", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
      visionReading({
        message: "nada",
        status: "unrecognized",
      }),
    );

    await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "extracto.PDF",
      mimeType: "",
      today: TODAY,
    });

    expect(
      vi.mocked(extractDocumentFromVisionAttachment).mock.calls[0]?.[0],
    ).toMatchObject({ kind: "pdf" });
  });
});
