import { describe, expect, it } from "vitest";

import {
  citesEuros,
  citesInternalSource,
  declinesToInvent,
  isSpanish,
  mentionsAll,
  mentionsAny,
  usedReadTool,
  type AssistantAnswer,
} from "./graders";

function answer(over: Partial<AssistantAnswer> = {}): AssistantAnswer {
  return { text: "", toolNames: [], quickActions: [], ...over };
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
    expect(usedReadTool(answer({ toolNames: ["get_financial_context"] }))).toBe(true);
  });

  it("ignores suggest_actions, which is not a grounding read", () => {
    expect(usedReadTool(answer({ toolNames: ["suggest_actions"] }))).toBe(false);
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
