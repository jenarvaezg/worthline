/**
 * The «Acciones recomendadas:» block the model writes in prose becomes chips, and the
 * block leaves the text whether or not its items converted (#1375) — as long as it is
 * an action list and not advice under an action heading.
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
    // The link is not made clickable — and the bullet does not survive as markdown
    // either: an unconvertible item leaves with its block (#1375).
    expect(splitProseActionBlock(text)).toEqual({ cleaned: "Texto.", actions: [] });
  });

  it("drops the item it cannot convert and still removes the block", () => {
    const text = [
      "Texto.",
      "",
      "Acciones recomendadas:",
      "- ¿Cuánto vale mi cartera?",
      "- [Ver algo que no existe](«Algo»)",
    ].join("\n");

    expect(splitProseActionBlock(text, [NUMISTA_CHIP])).toEqual({
      cleaned: "Texto.",
      actions: [
        {
          type: "runSuggestedAnalysis",
          label: "¿Cuánto vale mi cartera?",
          prompt: "¿Cuánto vale mi cartera?",
        },
      ],
    });
  });

  it("erases the reported block verbatim, chips or no chips (#1375)", () => {
    const text = [
      "Tu plan de pensiones vale 12.000 €.",
      "",
      "Acciones de seguimiento:",
      "• [Abrir detalles del Plan de Pensiones](openInternalSource?holding=«N5396 - Myinvestor Indexado Global PP»&section=patrimonio)",
      "• Ver resumen patrimonial [blocked]",
    ].join("\n");

    const { cleaned, actions } = splitProseActionBlock(text);

    // Not one bracket, paren or `[blocked]` left on screen: the block goes whole.
    expect(cleaned).toBe("Tu plan de pensiones vale 12.000 €.");
    expect(actions).toEqual([]);
  });

  it("removes a lone `[blocked]` bullet too, with no link beside it", () => {
    const text =
      "Texto.\n\nAcciones de seguimiento:\n• Ver resumen patrimonial [blocked]";

    expect(splitProseActionBlock(text)).toEqual({ cleaned: "Texto.", actions: [] });
  });

  it("does not turn advice into a button, nor delete it", () => {
    // Nothing here is machinery and nothing became a chip: it is a sentence written
    // for the reader, and answering broken markdown with a silence is not the fix.
    const text = [
      "Texto.",
      "",
      "Acciones recomendadas:",
      "- Revisa tu colchón de liquidez.",
      "- Considera amortizar la hipoteca antes de fin de año.",
    ].join("\n");

    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("keeps advice a footnote or a year happens to end with", () => {
    // One item deletes its whole block, so a bracketed tail that is not a state tag
    // would take four real recommendations with it.
    const text = [
      "Texto.",
      "",
      "Acciones recomendadas:",
      "- Aporta al plan de pensiones [límite 1.500 € anuales]",
      "- Revisa las comisiones del fondo [2025]",
    ].join("\n");

    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("keeps advice that carries a working internal link inside the sentence", () => {
    const text =
      "Texto.\n\nAcciones recomendadas:\n- Revisa [tu histórico](/historico) para ver la tendencia.";

    expect(splitProseActionBlock(text)).toEqual({ cleaned: text, actions: [] });
  });

  it("removes an item that spells out a holding's own route", () => {
    const text =
      "Texto.\n\nAcciones de seguimiento:\n• Abrir el plan (/patrimonio/wl_hld_abc/editar)";

    expect(splitProseActionBlock(text)).toEqual({ cleaned: "Texto.", actions: [] });
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

  it("caps a block longer than the chip cap without leaving its tail in the text", () => {
    const text = [
      "Texto.",
      "Acciones recomendadas:",
      "- ¿Una?",
      "- ¿Dos?",
      "- ¿Tres?",
      "- ¿Cuatro?",
      "- ¿Cinco?",
    ].join("\n");

    const { cleaned, actions } = splitProseActionBlock(text);

    expect(cleaned).toBe("Texto.");
    expect(actions.map((action) => action.label)).toEqual([
      "¿Una?",
      "¿Dos?",
      "¿Tres?",
      "¿Cuatro?",
    ]);
  });

  it("recovers the call the model narrated under a commented heading (#1407)", () => {
    // Verbatim shape from the report: `gpt-oss-120b` writes its commentary channel's
    // `// Acciones sugeridas:` and then the tool call itself as text.
    const text = [
      "El saldo pendiente de la hipoteca de Plasencia es de 41.230 €.",
      "",
      "// Acciones sugeridas:",
      '- [Analizar el estado de la deuda actual] (runSuggestedAnalysis:{"prompt":"Muéstrame el estado actual de la hipoteca de Plasencia y si hay alguna inconsistencia en el histórico."})',
      "- Abrir el detalle de la hipoteca [blocked]",
    ].join("\n");

    const { cleaned, actions } = splitProseActionBlock(text);

    expect(cleaned).toBe(
      "El saldo pendiente de la hipoteca de Plasencia es de 41.230 €.",
    );
    expect(actions).toEqual([
      {
        type: "runSuggestedAnalysis",
        label: "Analizar el estado de la deuda actual",
        prompt:
          "Muéstrame el estado actual de la hipoteca de Plasencia y si hay alguna inconsistencia en el histórico.",
      },
    ]);
  });

  it("reads the heading through a markdown heading marker", () => {
    const { cleaned, actions } = splitProseActionBlock(
      "Texto.\n\n## Acciones sugeridas\n- ¿Cuánto vale mi cartera?",
    );

    expect(cleaned).toBe("Texto.");
    expect(actions.map((action) => action.label)).toEqual(["¿Cuánto vale mi cartera?"]);
  });

  it("lets the app resolve the section of a narrated openInternalSource", () => {
    const { cleaned, actions } = splitProseActionBlock(
      'Texto.\n\n// Acciones sugeridas:\n- (openInternalSource:{"section":"patrimonio","label":"Ver tu patrimonio"})',
    );

    expect(cleaned).toBe("Texto.");
    expect(actions).toEqual([
      { type: "openInternalSource", label: "Ver tu patrimonio", href: "/patrimonio" },
    ]);
  });

  it("never lets a narrated call carry its own destination off-origin", () => {
    // The last one is the subtle one: the URL parser deletes the tab, so a href that
    // reads as a single-slash path resolves to `//evil.test/x` — another origin.
    const written = [
      "https://evil.test",
      "//evil.test/x",
      "/\\\\evil.test",
      "/\\t/evil.test/x",
      "javascript:alert(1)",
    ];
    for (const href of written) {
      const text = `Texto.\n\n// Acciones sugeridas:\n- [Mira esto] (openInternalSource:{"href":"${href}"})`;
      // The block still goes — it is the model's action list — but nothing clickable
      // comes out of a destination the model wrote.
      expect(splitProseActionBlock(text)).toEqual({ cleaned: "Texto.", actions: [] });
    }
  });

  it("recognises a narrated call for every type of quick action", () => {
    // A new quick-action type breaks this map in the typecheck, and with it this test:
    // `NARRATED_CALL` naming its own subset of the vocabulary is what would otherwise
    // fail in silence — the block would go and the chip would not come back.
    const narrated: Record<QuickAction["type"], string> = {
      openInternalSource: '(openInternalSource:{"section":"objetivos","label":"Ir"})',
      runSuggestedAnalysis:
        '(runSuggestedAnalysis:{"prompt":"¿Y ahora?","label":"Ahora"})',
    };

    for (const [type, item] of Object.entries(narrated)) {
      const { cleaned, actions } = splitProseActionBlock(
        `Texto.\n\n// Acciones sugeridas:\n- ${item}`,
      );
      expect(cleaned).toBe("Texto.");
      expect(actions.map((action) => action.type)).toEqual([type]);
    }
  });

  it("keeps an internal path a narrated call points at", () => {
    const { actions } = splitProseActionBlock(
      'Texto.\n\n// Acciones sugeridas:\n- [Ver histórico] (openInternalSource:{"href":"/historico"})',
    );

    expect(actions).toEqual([
      { type: "openInternalSource", label: "Ver histórico", href: "/historico" },
    ]);
  });

  it("drops a narrated call whose arguments are unreadable or over the caps", () => {
    const unreadable =
      'Texto.\n\n// Acciones sugeridas:\n- [Algo] (runSuggestedAnalysis:{"prompt":)';
    expect(splitProseActionBlock(unreadable)).toEqual({ cleaned: "Texto.", actions: [] });

    const tooLong = `Texto.\n\n// Acciones sugeridas:\n- [Algo] (runSuggestedAnalysis:{"prompt":"${"x".repeat(281)}"})`;
    expect(splitProseActionBlock(tooLong)).toEqual({ cleaned: "Texto.", actions: [] });
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
