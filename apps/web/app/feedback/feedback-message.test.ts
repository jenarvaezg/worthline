import { describe, expect, it } from "vitest";

import {
  FEEDBACK_MAX_LENGTH,
  feedbackFormView,
  parseFeedbackMessage,
  parseFeedbackPage,
} from "./feedback-message";

describe("parseFeedbackMessage", () => {
  it("accepts the text as typed, trimmed at the edges only", () => {
    expect(parseFeedbackMessage("  La gráfica no carga.\n\nEn móvil.  ")).toEqual({
      message: "La gráfica no carga.\n\nEn móvil.",
      ok: true,
    });
  });

  it("refuses an empty or blank message with a sentence a person can act on", () => {
    for (const raw of [null, "", "   \n ", 42]) {
      const parsed = parseFeedbackMessage(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/escribe/i);
    }
  });

  it("refuses a message over the cap instead of truncating what the user wrote", () => {
    const parsed = parseFeedbackMessage("a".repeat(FEEDBACK_MAX_LENGTH + 1));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("4.000");
    expect(parseFeedbackMessage("a".repeat(FEEDBACK_MAX_LENGTH)).ok).toBe(true);
  });
});

describe("parseFeedbackPage", () => {
  it("keeps the pathname and drops the query and the hash", () => {
    // A query string can carry typed amounts (#1311); the pathname is enough to
    // know which screen the message is about.
    expect(parseFeedbackPage("/patrimonio/wl_hld_casa/editar?importe=1200#cobros")).toBe(
      "/patrimonio/wl_hld_casa/editar",
    );
  });

  it("refuses anything that is not an in-app path", () => {
    for (const raw of [null, "", "https://evil.example/x", "//evil.example", 7, "x"]) {
      expect(parseFeedbackPage(raw)).toBeNull();
    }
    expect(parseFeedbackPage(`/${"a".repeat(300)}`)).toBeNull();
  });
});

describe("feedbackFormView", () => {
  it("cannot be sent empty, and says nothing before the first send", () => {
    expect(
      feedbackFormView({ draft: "  ", pending: false, state: { status: "idle" } }),
    ).toEqual({
      canSubmit: false,
      status: null,
      submitLabel: "Enviar",
    });
  });

  it("shows an honest pending while the server decides", () => {
    const view = feedbackFormView({
      draft: "hola",
      pending: true,
      state: { status: "idle" },
    });

    expect(view.canSubmit).toBe(false);
    expect(view.submitLabel).toBe("Enviando…");
    expect(view.status).toEqual({ text: "Enviando…", tone: "pending" });
  });

  it("confirms a delivered message until the user starts a new one", () => {
    const sent = { status: "sent" as const };

    expect(feedbackFormView({ draft: "", pending: false, state: sent }).status).toEqual({
      text: "Recibido, gracias. Ya le ha llegado al desarrollador.",
      tone: "sent",
    });
    expect(
      feedbackFormView({ draft: "otra cosa", pending: false, state: sent }).status,
    ).toBeNull();
  });

  it("keeps the error on screen while the draft is still there to retry", () => {
    const view = feedbackFormView({
      draft: "mi mensaje",
      pending: false,
      state: { error: "No se ha podido enviar.", status: "error" },
    });

    expect(view.canSubmit).toBe(true);
    expect(view.status).toEqual({ text: "No se ha podido enviar.", tone: "error" });
  });
});
