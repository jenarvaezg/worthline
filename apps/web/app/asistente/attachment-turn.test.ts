import { parseExtractionResult } from "@web/asistente/attachment-extraction-contract";
import {
  UNIDENTIFIED_DOCUMENT_MESSAGE,
  UNSTRUCTURED_SPREADSHEET_MESSAGE,
  UNSTRUCTURED_VISION_MESSAGE,
} from "@web/asistente/attachment-types";
import { describeVisionAttachment } from "@web/asistente/attachment-vision-description";
import { extractDocumentFromVisionAttachment } from "@web/asistente/attachment-vision-extractor";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isVisionAttachment, readAttachmentTurn } from "./attachment-turn";

vi.mock("@web/asistente/attachment-vision-extractor", () => ({
  extractDocumentFromVisionAttachment: vi.fn(),
}));
vi.mock("@web/asistente/attachment-vision-description", () => ({
  describeVisionAttachment: vi.fn(),
}));

function csv(text: string): { bytes: Uint8Array; fileName: string; mimeType: string } {
  return {
    bytes: new TextEncoder().encode(text),
    fileName: "hoja.csv",
    mimeType: "text/csv",
  };
}

const POSITIONS_CSV = [
  "Símbolo;Nombre;Unidades;Valor de mercado EUR;Divisa",
  "VWCE;Vanguard FTSE All-World;120;13450,32;EUR",
].join("\n");

const NOT_A_POSITIONS_TABLE_CSV = [
  "Concepto;Saldo;Fecha",
  "Cuenta corriente conjunta;12.930,44;30/06/2026",
].join("\n");

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
    const reading = await readAttachmentTurn(csv(NOT_A_POSITIONS_TABLE_CSV));

    expect(reading.preview.result).toEqual({
      message: UNSTRUCTURED_SPREADSHEET_MESSAGE,
      status: "unrecognized",
    });
    expect(reading.unstructured?.source).toBe("spreadsheet_grid");
    expect(reading.unstructured?.text).toContain("Cuenta corriente conjunta");
    // A workbook never reaches a vision model: the deterministic route owns it.
    expect(extractDocumentFromVisionAttachment).not.toHaveBeenCalled();
    expect(describeVisionAttachment).not.toHaveBeenCalled();
  });

  it("trims the user-supplied file name once, here", async () => {
    const reading = await readAttachmentTurn({
      ...csv(POSITIONS_CSV),
      fileName: "  hoja.csv  ",
    });

    expect(reading.preview.fileName).toBe("hoja.csv");
  });

  it("describes a capture whose document the seam did not identify", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "no lo reconozco",
      reason: "unidentified_document",
      status: "unrecognized",
    });
    vi.mocked(describeVisionAttachment).mockResolvedValue("Se ve una pantalla de pago.");

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
    });

    expect(reading.unstructured).toEqual({
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
    // The two constants are the coupling: `declinedHoldingEvent` in the extractor
    // returns exactly this envelope, and `readAttachmentTurn` keys off `reason`.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: UNIDENTIFIED_DOCUMENT_MESSAGE,
      reason: "unidentified_document",
      status: "unrecognized",
    });
    vi.mocked(describeVisionAttachment).mockResolvedValue(
      "Se ven doce apuntes con fecha e importe.",
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "movimientos.png",
      mimeType: "image/png",
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

  it("pays for no description when the document WAS identified and read empty", async () => {
    // `empty_reading` means the seam knew what it was looking at, so a second vision
    // call would buy nothing — and the user waits for it pre-stream.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "no he podido leer ninguna fila",
      reason: "empty_reading",
      status: "unrecognized",
    });

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
    });

    expect(reading.unstructured).toBeNull();
    expect(describeVisionAttachment).not.toHaveBeenCalled();
  });

  it("leaves the extractor's own verdict standing when nothing describes the capture", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "no lo reconozco",
      reason: "unidentified_document",
      status: "unrecognized",
    });
    vi.mocked(describeVisionAttachment).mockResolvedValue(null);

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
    });

    expect(reading.unstructured).toBeNull();
    expect(reading.preview.result).toMatchObject({ message: "no lo reconozco" });
  });

  it("routes a PDF through the same vision seam as a picture", async () => {
    // The MIME type picks the transport only (#1243): one seam identifies the document
    // behind an image or a PDF by its content.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "nada",
      status: "unrecognized",
    });

    await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "extracto.pdf",
      mimeType: "application/pdf",
    });

    expect(
      vi.mocked(extractDocumentFromVisionAttachment).mock.calls[0]?.[0],
    ).toMatchObject({ kind: "pdf" });
  });

  it("charges nothing for the deterministic spreadsheet route", async () => {
    // The seam's report is what the money fuse counts (#1258), so «no model was
    // called» has to arrive as a zero, not as an absent field.
    expect((await readAttachmentTurn(csv(POSITIONS_CSV))).visionCalls).toBe(0);
    expect((await readAttachmentTurn(csv(NOT_A_POSITIONS_TABLE_CSV))).visionCalls).toBe(
      0,
    );
  });

  it("charges one call for a document the seam identified", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue(
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
    );

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
    });

    expect(reading.visionCalls).toBe(1);
  });

  it("charges TWO calls for the descriptive cascade — the cost #1246 added", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "no lo reconozco",
      reason: "unidentified_document",
      status: "unrecognized",
    });
    vi.mocked(describeVisionAttachment).mockResolvedValue("Se ve una pantalla de pago.");

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
    });

    expect(reading.visionCalls).toBe(2);
  });

  it("still charges the description the provider never answered", async () => {
    // The request was made. Counting only successful answers would hand an abuser a
    // free lane precisely when the provider is struggling.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "no lo reconozco",
      reason: "unidentified_document",
      status: "unrecognized",
    });
    vi.mocked(describeVisionAttachment).mockResolvedValue(null);

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "captura.png",
      mimeType: "image/png",
    });

    expect(reading.visionCalls).toBe(2);
  });

  it("charges nothing for a «PDF» whose bytes are not a PDF", async () => {
    // Decided by `looksLikePdf` over bytes already in memory, before the API key is
    // even read. Charging it would let a caller burn their allowance for free.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      code: "unsupported_document",
      failure: "permanent",
      message: "El archivo no es un PDF legible.",
      status: "failure",
    });

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "extracto.pdf",
      mimeType: "application/pdf",
    });

    expect(reading.visionCalls).toBe(0);
  });

  it("charges nothing for a file the contract refused before any provider", async () => {
    // An oversized upload is decided over bytes already in memory. Charging it would
    // let a user burn their own daily allowance on files no model ever saw.
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "El archivo es demasiado grande.",
      reason: "size",
      status: "out_of_limits",
    });

    const reading = await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "enorme.png",
      mimeType: "image/png",
    });

    expect(reading.visionCalls).toBe(0);
    expect(describeVisionAttachment).not.toHaveBeenCalled();
  });

  it("treats a PDF by extension even when the browser sends no MIME type", async () => {
    vi.mocked(extractDocumentFromVisionAttachment).mockResolvedValue({
      message: "nada",
      status: "unrecognized",
    });

    await readAttachmentTurn({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "extracto.PDF",
      mimeType: "",
    });

    expect(
      vi.mocked(extractDocumentFromVisionAttachment).mock.calls[0]?.[0],
    ).toMatchObject({ kind: "pdf" });
  });
});
