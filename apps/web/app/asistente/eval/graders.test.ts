import { describe, expect, it } from "vitest";

import {
  type AssistantAnswer,
  citesEuros,
  citesInternalSource,
  claimsAnInventedMechanism,
  claimsDistinctInstrumentWithoutResolving,
  commentsOnTheInterface,
  declinesToInvent,
  deniesCapabilityAbout,
  isSpanish,
  mentionsAll,
  mentionsAny,
  recommendsExternalTool,
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

describe("claimsDistinctInstrumentWithoutResolving (#1489)", () => {
  const claim =
    "El ETF que aparece en tu extracto (IE00B52MJY50) es distinto al que tengo " +
    "registrado en tu cartera, con el símbolo SXR1.DE.";

  it("catches the sentence that reached a real user", () => {
    expect(claimsDistinctInstrumentWithoutResolving(answer({ text: claim }))).toBe(true);
  });

  it("catches the fronted phrasings too", () => {
    for (const text of [
      "Ese ISIN corresponde a otro fondo, no al que tienes.",
      "Se trata de un producto diferente del que figura en tu patrimonio.",
    ]) {
      expect(claimsDistinctInstrumentWithoutResolving(answer({ text })), text).toBe(true);
    }
  });

  it("allows the claim once the keys were actually resolved", () => {
    expect(
      claimsDistinctInstrumentWithoutResolving(
        answer({
          text: claim,
          toolCalls: [{ name: "search_market_symbol", input: { query: "IE00B52MJY50" } }],
        }),
      ),
    ).toBe(false);
  });

  it("does not punish the honest hedge", () => {
    expect(
      claimsDistinctInstrumentWithoutResolving(
        answer({
          text:
            "No puedo confirmar que el ISIN del extracto y el símbolo de tu posición " +
            "sean el mismo producto. ¿Lo son?",
        }),
      ),
    ).toBe(false);
  });

  it("does not punish a true sentence about a figure or a date", () => {
    for (const text of [
      "El importe del extracto es distinto al que tienes registrado: 1.204,50 € frente a 1.180,00 €.",
      "La fecha de la operación es diferente de la que consta en tu histórico.",
    ]) {
      expect(claimsDistinctInstrumentWithoutResolving(answer({ text })), text).toBe(
        false,
      );
    }
  });
});

/**
 * #1524 — the two graders that stop the assistant from talking a user out of a field
 * the product has. Both are sentence-scoped and subject-scoped on purpose: the same
 * words are the RIGHT answer about something worthline genuinely does not do, and a
 * grader that could not tell the two apart would score honesty as a defect.
 */
describe("deniesCapabilityAbout", () => {
  it("catches the 2026-08-21 denials, verbatim", () => {
    for (const text of [
      "En worthline, el registro de gastos operativos sobre una vivienda (como comunidad, IBI, seguros o reformas) no se introduce directamente.",
      "Esos gastos operativos no se registran individualmente en worthline.",
      "No existe una cuenta de gastos: worthline está construida sobre un modelo de balance.",
      "No hay un libro de gastos donde apuntar el IBI.",
      "No puedes declarar los gastos de comunidad de un inmueble.",
    ]) {
      expect(deniesCapabilityAbout(text, ["gasto", "ibi", "comunidad"]), text).toBe(true);
    }
  });

  it("leaves the honest denial about another subject alone", () => {
    // The `spending-missing` golden grades this as the RIGHT answer: worthline really
    // does not track what you spend on food. A denial matcher blind to the subject
    // would fail the model for being truthful.
    const text =
      "No se registra tu gasto en comida y ocio: worthline mide patrimonio, no consumo.";
    expect(deniesCapabilityAbout(text, ["alquiler", "ibi"])).toBe(false);
    // …and it still fires when the subject IS the one the product covers.
    expect(deniesCapabilityAbout(text, ["gasto"])).toBe(true);
  });

  it("does not fire on a fact about the user's own data", () => {
    // «No hay gastos declarados en este alquiler» is a READING, and the one this whole
    // issue wanted said out loud. It must never read as «worthline cannot do it».
    for (const text of [
      "Tu alquiler de Plasencia no tiene gastos declarados todavía, así que tu FIRE usa el retorno por defecto del tramo.",
      "Los gastos de ese cobro recurrente están vacíos: se declaran en la ficha del inmueble.",
    ]) {
      expect(deniesCapabilityAbout(text, ["gasto", "ibi"]), text).toBe(false);
    }
  });

  it("needs the denial and the subject in the SAME sentence", () => {
    const text = "No hay histórico anterior a 2024. Los gastos van en «Cobros».";
    expect(deniesCapabilityAbout(text, ["gasto"])).toBe(false);
  });

  it("reads «no hay registro de X» as a reading, not as a denial", () => {
    // The narrowest call in this grader: «registro» is a place-shaped noun, but the
    // sentence is about the user's data. The transcript's real denials never needed it.
    expect(
      deniesCapabilityAbout("No hay registro de gastos en tus viviendas.", ["gasto"]),
    ).toBe(false);
    // «No hay forma de…» is the same shape and IS a claim about the product.
    expect(
      deniesCapabilityAbout("No hay forma de declarar esos gastos.", ["gasto"]),
    ).toBe(true);
  });
});

describe("recommendsExternalTool", () => {
  it("catches the eviction the user actually received", () => {
    for (const text of [
      "Te recomiendo utilizar una herramienta de gestión de gastos o una hoja de cálculo externa.",
      "Para eso necesitarás otra aplicación.",
      "Anótalo en un Excel aparte.",
    ]) {
      expect(recommendsExternalTool(text), text).toBe(true);
    }
  });

  it("allows worthline's own upload lane, spreadsheets included", () => {
    // The starring action of onboarding (PRD #1167) names a spreadsheet as an INPUT.
    // Counting that as an eviction would punish the product's own best path.
    for (const text of [
      "Súbeme tu Excel y te levanto las propuestas.",
      "Si lo tienes en una hoja de cálculo, adjúntala y la leo.",
      "Puedes importar tu hoja de cálculo desde /patrimonio/importar-extracto.",
    ]) {
      expect(recommendsExternalTool(text), text).toBe(false);
    }
  });

  it("stays quiet on an answer that just names the destination", () => {
    expect(
      recommendsExternalTool(
        "Los gastos de ese alquiler se declaran en la ficha del inmueble, en «Cobros».",
      ),
    ).toBe(false);
  });
});
