import { describe, expect, it } from "vitest";

import {
  FEEDBACK_MAX_LENGTH,
  feedbackFormView,
  parseFeedbackId,
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

  it("measures line breaks as the textarea does, whatever the transport did to them", () => {
    // A form post turns every LF into CRLF. Measured raw, a message that fit in the
    // textarea would be refused by the server for line breaks the user never typed
    // twice — the client and the server would disagree about the same text.
    const lines = Array.from({ length: 1000 }, () => "abc").join("\n");
    expect(lines.length).toBe(FEEDBACK_MAX_LENGTH - 1);

    const posted = lines.replaceAll("\n", "\r\n");

    expect(parseFeedbackMessage(posted)).toEqual({ message: lines, ok: true });
    expect(parseFeedbackMessage("una\rdos")).toEqual({ message: "una\ndos", ok: true });
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

describe("parseFeedbackId", () => {
  it("keeps the client's id for this draft, so a retry is the same message", () => {
    expect(parseFeedbackId("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(
      "0f8fad5b-d9cb-469f-a165-70867728950e",
    );
  });

  it("refuses anything that is not a uuid", () => {
    for (const raw of [null, "", "../../x", "feedback:1", 7, `${"a".repeat(36)}`]) {
      expect(parseFeedbackId(raw)).toBeNull();
    }
  });
});

describe("feedbackFormView", () => {
  it("cannot be sent empty, and says nothing before the first send", () => {
    expect(
      feedbackFormView({ draft: "  ", pending: false, state: { status: "idle" } }),
    ).toEqual({
      canSubmit: false,
      status: null,
      statusClassName: "feedbackStatus",
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
    expect(view.statusClassName).toBe("feedbackStatus");
  });

  it("confirms a delivered message until the user starts a new one", () => {
    const sent = { status: "sent" as const };

    const confirmed = feedbackFormView({ draft: "", pending: false, state: sent });
    expect(confirmed.status).toEqual({
      text: "Recibido, gracias. Ya le ha llegado al desarrollador.",
      tone: "sent",
    });
    expect(confirmed.statusClassName).toBe("feedbackStatus successBand");
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
    expect(view.statusClassName).toBe("feedbackStatus formError");
  });

  it("refuses an over-long draft with the server's own words, before sending", () => {
    // The same `parseFeedbackMessage` decides on both sides, so the button can never
    // offer a send the server would refuse for length.
    const view = feedbackFormView({
      draft: "a".repeat(FEEDBACK_MAX_LENGTH + 1),
      pending: false,
      state: { status: "idle" },
    });

    expect(view.canSubmit).toBe(false);
    expect(view.status?.tone).toBe("error");
    expect(view.status?.text).toContain("4.000");
  });
});
