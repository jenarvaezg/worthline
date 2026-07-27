import { UNSTRUCTURED_SPREADSHEET_MESSAGE } from "@web/asistente/attachment-types";
import { describeVisionAttachment } from "@web/asistente/attachment-vision-description";
import { extractDocumentFromVisionAttachment } from "@web/asistente/attachment-vision-extractor";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readAttachmentTurn } from "./attachment-turn";

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
