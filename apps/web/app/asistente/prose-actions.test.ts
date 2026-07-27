/**
 * The «Acciones recomendadas:» block the model writes in prose becomes chips, or
 * the prose is left exactly as it was. Nothing in between.
 */

import type { QuickAction } from "@web/asistente/assistant-actions";
import { mergeQuickActions, splitProseActionBlock } from "@web/asistente/prose-actions";
import { describe, expect, it } from "vitest";

const NUMISTA_CHIP: QuickAction = {
  type: "openInternalSource",
  label: "Ver detalle de la Colección Numista",
  href: "/patrimonio/wl_hld_x/editar",
};

describe("splitProseActionBlock", () => {
  it("converts the reported block: a link with a made-up destination plus a question", () => {
    const text = [
      "La moneda más cara es la de 148 €.",
      "",
      "Acciones recomendadas:",
      "- [Ver detalle de la Colección Numista](«Colección Numista»)",
      "- ¿Cuál es el valor total de mi colección de monedas en Numista?",
    ].join("\n");

    const { cleaned, actions } = splitProseActionBlock(text, [NUMISTA_CHIP]);

    expect(cleaned).toBe("La moneda más cara es la de 148 €.");
    expect(actions).toEqual([
      NUMISTA_CHIP,
      {
        type: "runSuggestedAnalysis",
        label: "¿Cuál es el valor total de mi colección de monedas en Numista?",
        prompt: "¿Cuál es el valor total de mi colección de monedas en Numista?",
      },
    ]);
  });

  it("keeps an internal path written in prose as the destination", () => {
    const { cleaned, actions } = splitProseActionBlock(
      "Texto.\n\n**Acciones sugeridas:**\n1. [Ver patrimonio](/patrimonio)",
    );

    expect(cleaned).toBe("Texto.");
    expect(actions).toEqual([
      { type: "openInternalSource", label: "Ver patrimonio", href: "/patrimonio" },
    ]);
  });

  it("never lets prose reach an external destination", () => {
    const text = "Texto.\n\nAcciones recomendadas:\n- [Mira esto](https://evil.test)";
    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("leaves the whole block when one item does not resolve", () => {
    const text = [
      "Texto.",
      "",
      "Acciones recomendadas:",
      "- ¿Cuánto vale mi cartera?",
      "- [Ver algo que no existe](«Algo»)",
    ].join("\n");

    expect(splitProseActionBlock(text, [NUMISTA_CHIP])).toEqual({
      cleaned: text,
      actions: [],
    });
  });

  it("does not turn advice into a button", () => {
    const text = "Texto.\n\nAcciones recomendadas:\n- Revisa tu colchón de liquidez.";
    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("ignores a list that is not an action block", () => {
    const text = "Tus mayores posiciones:\n- Fondo A\n- Fondo B";
    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("ignores a block that is not at the end of the reply", () => {
    const text = [
      "Acciones recomendadas:",
      "- ¿Cuánto vale mi cartera?",
      "",
      "Y además esto otro que sigue explicando.",
    ].join("\n");

    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("refuses a block longer than the chip cap instead of truncating it", () => {
    const text = [
      "Texto.",
      "Acciones recomendadas:",
      "- ¿Una?",
      "- ¿Dos?",
      "- ¿Tres?",
      "- ¿Cuatro?",
      "- ¿Cinco?",
    ].join("\n");

    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("matches a repeated chip through emphasis and trailing punctuation", () => {
    const { actions } = splitProseActionBlock(
      "Texto.\n\nAcciones de seguimiento:\n- **Ver detalle de la Colección Numista.**",
      [NUMISTA_CHIP],
    );
    expect(actions).toEqual([NUMISTA_CHIP]);
  });
});

describe("mergeQuickActions", () => {
  it("keeps the order the reader saw and drops the repeat", () => {
    const question: QuickAction = {
      type: "runSuggestedAnalysis",
      label: "¿Valor total?",
      prompt: "¿Valor total?",
    };

    expect(mergeQuickActions([NUMISTA_CHIP, question], [NUMISTA_CHIP])).toEqual([
      NUMISTA_CHIP,
      question,
    ]);
  });

  it("de-duplicates on the destination, not the wording", () => {
    const relabelled: QuickAction = { ...NUMISTA_CHIP, label: "Abrir la colección" };
    expect(mergeQuickActions([NUMISTA_CHIP], [relabelled])).toEqual([NUMISTA_CHIP]);
  });

  it("caps the merged set", () => {
    const run = (n: number): QuickAction => ({
      type: "runSuggestedAnalysis",
      label: `¿${n}?`,
      prompt: `¿${n}?`,
    });
    expect(mergeQuickActions([run(1), run(2), run(3)], [run(4), run(5)])).toHaveLength(4);
  });
});
