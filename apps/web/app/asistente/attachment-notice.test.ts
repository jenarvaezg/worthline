import { describe, expect, test } from "vitest";

import {
  attachmentNotice,
  attachmentNoticeFileName,
  userTurnText,
} from "./attachment-notice";

/**
 * #1285: a turn that carries a file says so, whether or not the user also typed.
 */
describe("the attachment leaves a trace in the user's own turn (#1285)", () => {
  test("keeps the drag-and-drop turn exactly as it always read", () => {
    expect(userTurnText("", "extracto.csv")).toBe("Adjunto: extracto.csv");
  });

  test("names the file when the user typed a sentence too", () => {
    expect(userTurnText("He hecho este pago anticipado", "captura.jpg")).toBe(
      "He hecho este pago anticipado\n\nAdjunto: captura.jpg",
    );
  });

  test("leaves a turn with no attachment untouched", () => {
    expect(userTurnText("¿Cómo va mi patrimonio?", null)).toBe("¿Cómo va mi patrimonio?");
  });

  test("trims, so the notice never hangs off blank space", () => {
    expect(userTurnText("  hola  ", "  a.pdf  ")).toBe("hola\n\nAdjunto: a.pdf");
  });

  test("treats a blank file name as no attachment at all", () => {
    expect(userTurnText("hola", "   ")).toBe("hola");
  });

  test("reads the file name back out of a turn it wrote", () => {
    expect(attachmentNoticeFileName(userTurnText("hola", "captura.jpg"))).toBe(
      "captura.jpg",
    );
    expect(attachmentNoticeFileName(userTurnText("", "captura.jpg"))).toBe("captura.jpg");
  });

  test("finds no file where none was sent", () => {
    expect(attachmentNoticeFileName("¿Cómo va mi patrimonio?")).toBeNull();
    expect(attachmentNoticeFileName("")).toBeNull();
  });

  test("reads the LAST notice, so an older turn's file is never the current one", () => {
    const conversation = `${attachmentNotice("viejo.csv")}\nalgo\n${attachmentNotice("nuevo.jpg")}`;

    expect(attachmentNoticeFileName(conversation)).toBe("nuevo.jpg");
  });

  test("survives a name with the separator inside it", () => {
    expect(attachmentNoticeFileName(userTurnText("", "Adjunto: raro.png"))).toBe(
      "Adjunto: raro.png",
    );
  });
});
