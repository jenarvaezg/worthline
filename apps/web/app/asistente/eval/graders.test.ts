import { describe, expect, it } from "vitest";

import {
  type AssistantAnswer,
  citesEuros,
  citesInternalSource,
  claimsAnInventedMechanism,
  commentsOnTheInterface,
  declinesToInvent,
  isSpanish,
  mentionsAll,
  mentionsAny,
  usedReadTool,
} from "./graders";

function answer(over: Partial<AssistantAnswer> = {}): AssistantAnswer {
  return { text: "", toolCalls: [], toolResults: [], quickActions: [], ...over };
}

describe("isSpanish", () => {
  it("accepts a Spanish sentence", () => {
    expect(isSpanish("Tu patrimonio líquido es de 12.585 € a día de hoy.")).toBe(true);
  });

  it("rejects an English sentence", () => {
    expect(isSpanish("Your liquid net worth is 12,585 EUR as of today.")).toBe(false);
  });
});

describe("citesEuros", () => {
  it("detects an es-ES formatted amount", () => {
    expect(citesEuros("El total asciende a 1.234.567,89 €.")).toBe(true);
  });

  it("is false when no euro figure is cited", () => {
    expect(citesEuros("No dispongo de ese dato.")).toBe(false);
  });
});

describe("declinesToInvent", () => {
  it("recognises an honest missing-fact answer", () => {
    expect(declinesToInvent("No consta el tipo de interés de esa hipoteca.")).toBe(true);
  });

  it("does not fire on a confident answer with a figure", () => {
    expect(declinesToInvent("Tu hipoteca es de 120.000 € al 2,1 %.")).toBe(false);
  });
});

describe("mentions", () => {
  it("mentionsAll requires every term (case/accent-insensitive)", () => {
    const text = "Tu patrimonio LÍQUIDO difiere del patrimonio total.";
    expect(mentionsAll(text, ["líquido", "total"])).toBe(true);
    expect(mentionsAll(text, ["líquido", "vivienda"])).toBe(false);
  });

  it("mentionsAny requires at least one term", () => {
    expect(
      mentionsAny("El cambio viene de tus aportaciones.", ["aportacion", "mercado"]),
    ).toBe(true);
    expect(mentionsAny("Sin cambios relevantes.", ["aportacion", "mercado"])).toBe(false);
  });
});

describe("usedReadTool", () => {
  it("is true when a grounding read tool ran", () => {
    expect(
      usedReadTool(answer({ toolCalls: [{ input: {}, name: "get_financial_context" }] })),
    ).toBe(true);
  });

  it("ignores suggest_actions, which is not a grounding read", () => {
    expect(
      usedReadTool(answer({ toolCalls: [{ input: {}, name: "suggest_actions" }] })),
    ).toBe(false);
  });
});

describe("citesInternalSource", () => {
  it("is true when the model proposed an openInternalSource action", () => {
    expect(
      citesInternalSource(
        answer({
          quickActions: [
            { type: "openInternalSource", label: "Ver histórico", href: "/historico" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is false when only a follow-up analysis was proposed", () => {
    expect(
      citesInternalSource(
        answer({
          quickActions: [
            { type: "runSuggestedAnalysis", label: "¿Y mi liquidez?", prompt: "…" },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("commentsOnTheInterface", () => {
  it("catches the session that explained the card and the button (#1376)", () => {
    for (const text of [
      "Te he dejado la tarjeta pendiente aquí abajo.",
      "Pulsa el botón de confirmar cuando lo hayas revisado.",
      "Acciones sugeridas: revisar la posición.",
      "propose_operation [blocked]",
    ]) {
      expect(commentsOnTheInterface(text), text).toBe(true);
    }
  });

  it("leaves the obedient answer alone", () => {
    // The product WANTS the user asked to confirm; the prompt only bans talking about
    // the furniture. A check that failed this would score the honest turn as a defect.
    expect(
      commentsOnTheInterface(
        "He preparado la aportación de 480 € del 29/05/2026 sobre el ETF MSCI World " +
          "Small Cap. Confírmala si el destino es el correcto.",
      ),
    ).toBe(false);
  });
});

describe("claimsAnInventedMechanism", () => {
  it("catches the recalibration nobody implements (#1376)", () => {
    for (const text of [
      "Al confirmar, worthline suma los 480 € y recalibra la valoración de la posición.",
      "El importe ajusta la valoración de tu fondo.",
      "Con eso se recalcula la valoración del holding.",
    ]) {
      expect(claimsAnInventedMechanism(text), text).toBe(true);
    }
  });

  it("does not punish the true sentence about the ripple", () => {
    // The position IS revalued at today's price after the operation lands — that is why
    // `propose_operation`'s card marks its impact «estimado». Grading it as invention
    // would be the plausible-looking check that fails the right answer.
    expect(
      claimsAnInventedMechanism(
        "La posición se revaloriza al precio de hoy, así que el impacto es estimado.",
      ),
    ).toBe(false);
  });
});
