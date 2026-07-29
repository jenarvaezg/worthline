import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";

import {
  claimsPreparedProposal,
  messagesWithFabricatedProposal,
} from "./fabricated-proposal";

/** The prose the model actually emitted in production (#1262), trimmed. */
const PRODUCTION_INCIDENT =
  "He preparado la propuesta de corrección para actualizar el saldo a 5.511,96 € " +
  "con fecha 24 de julio:\n\n- **Holding:** Préstamos Revolut\n- **Nuevo saldo:** " +
  "5.511,96 €\n\nAl confirmar esta propuesta, tu contabilidad de deuda quedará " +
  "actualizada.\n\n¿Deseas que proceda con la aplicación de este cambio?";

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, parts, role: "assistant" };
}

function textPart(text: string): UIMessage["parts"][number] {
  return { text, type: "text" };
}

function proposalPart(): UIMessage["parts"][number] {
  return {
    input: { holdingId: "wl_hld_1" },
    output: { mode: "declare_balance", proposalId: "p1" },
    state: "output-available",
    toolCallId: "call-1",
    type: "tool-propose_correction",
  } as unknown as UIMessage["parts"][number];
}

describe("claimsPreparedProposal", () => {
  test("recognises the claim the model made in production", () => {
    expect(claimsPreparedProposal(PRODUCTION_INCIDENT)).toBe(true);
  });

  test("recognises the other ways of asserting one exists", () => {
    for (const text of [
      "He preparado la propuesta.",
      "Te he preparado una propuesta de corrección.",
      "Ya he creado la propuesta con el saldo nuevo.",
      "Aquí tienes la propuesta para que la revises.",
      "La propuesta está lista.",
      "La propuesta queda preparada más abajo.",
      "He dejado preparada la propuesta de amortización.",
    ]) {
      expect(claimsPreparedProposal(text), text).toBe(true);
    }
  });

  test("does NOT fire on an offer to prepare one, which is the honest turn", () => {
    // This is the shape of a correct answer when the model still needs data, and
    // it is far more common than the defect. A note here would be noise on the
    // path that works.
    for (const text of [
      "Si quieres, te preparo la propuesta de corrección.",
      "¿Quieres que prepare una propuesta con ese saldo?",
      "Voy a preparar la propuesta en cuanto me digas la fecha.",
      "Prepararé la propuesta cuando confirmes el importe.",
      "Necesito la fecha para poder preparar la propuesta.",
      "Puedo preparar una propuesta, pero antes dime de qué deuda hablamos.",
      "No puedo preparar la propuesta: esa deuda es de fuente conectada.",
    ]) {
      expect(claimsPreparedProposal(text), text).toBe(false);
    }
  });

  test("does NOT fire on merely asking for confirmation", () => {
    // Ambiguous on its own: it may refer to a REAL card from an earlier turn,
    // still on screen with its own button. Only an assertion that one was
    // prepared is a claim the server can contradict.
    expect(claimsPreparedProposal("Al confirmar esta propuesta se actualiza.")).toBe(
      false,
    );
    expect(claimsPreparedProposal("¿Confirmas la propuesta?")).toBe(false);
  });

  test("does NOT fire on a claim the model itself negates", () => {
    // Found in review. The second one is the turn the model produces right AFTER
    // being corrected, so without this the two seams feed each other: the history
    // note provokes the sentence that trips the screen note.
    for (const text of [
      "No he preparado ninguna propuesta todavía, necesito el dato antes.",
      "Tienes razón: no he preparado la propuesta. La preparo ahora.",
      "Nunca he preparado esa propuesta.",
    ]) {
      expect(claimsPreparedProposal(text), text).toBe(false);
    }
  });

  test("«aquí tienes» must be handing over the proposal, not just mentioning it", () => {
    expect(
      claimsPreparedProposal("Aquí tienes las opciones antes de montar una propuesta."),
    ).toBe(false);
    expect(claimsPreparedProposal("Aquí tienes la propuesta.")).toBe(true);
  });

  test("also reads the preterite and «ya tienes», which the first pass missed", () => {
    expect(
      claimsPreparedProposal("Preparé la propuesta con el saldo de 5.511,96 €."),
    ).toBe(true);
    expect(
      claimsPreparedProposal("Ya tienes la propuesta preparada, solo falta confirmarla."),
    ).toBe(true);
  });

  test("still fires when the claim points at a card from an EARLIER turn", () => {
    // Deliberate, and the sharpest trade-off in this module. Such a turn is honest:
    // the card exists, one message up. But «la propuesta está preparada» in a turn
    // that carries no proposal is also exactly what a fabrication looks like AFTER a
    // real proposal — the most dangerous case, because the user is already primed to
    // confirm. Telling apart «that card» from «a different one I invented» needs a
    // referent, which no regex has. So the note stays, and it is worded to be TRUE
    // and useful in both worlds: it talks about this message and points at the
    // button, never at what the model meant.
    for (const text of [
      "Como te decía, la propuesta está preparada; confírmala en la tarjeta.",
      "La propuesta ya está lista arriba: pulsa Confirmar en la tarjeta.",
    ]) {
      expect(claimsPreparedProposal(text), text).toBe(true);
    }
  });

  test("ignores text with no proposal vocabulary at all", () => {
    expect(claimsPreparedProposal("Tu patrimonio neto es de 412.000 €.")).toBe(false);
    expect(claimsPreparedProposal("")).toBe(false);
  });

  test("recognises the ceremony loop a measured run used to dodge it (#1327)", () => {
    // Verbatim from the 2026-07-28 transcript: five turns of prose-imitated cards
    // that burned a free user's whole monthly quota without one card on screen.
    for (const text of [
      "Estas son las propuestas para los fondos con operaciones en vuelo que hemos ajustado según tus indicaciones (incluyendo el ISIN y el valor total).",
      "ISIN: IE000N51F726. Valor a registrar: 294,80 €. Estado: Preparado para alta.",
      "Excelente, el segundo registro está listo.",
      "He corregido las propuestas de alta siguiendo estrictamente tu indicación.",
    ]) {
      expect(claimsPreparedProposal(text), text).toBe(true);
    }
  });

  test("the widened vocabulary still spares the honest turns (#1327)", () => {
    for (const text of [
      // Offers and questions around the new verbs.
      "¿Quieres que ajuste la propuesta antes de emitirla?",
      "Puedo corregir la propuesta si me confirmas el importe.",
      // «registrado» (participle) is not the noun «registro»: preference talk.
      "Perfecto, tu preferencia queda registrada.",
      // A negated claim keeps not being a claim, also for the new patterns.
      "No, el registro no está listo todavía: falta el importe.",
      // Plain financial prose around the word «estado».
      "El estado de tu cartera es saludable.",
    ]) {
      expect(claimsPreparedProposal(text), text).toBe(false);
    }
  });
});

describe("messagesWithFabricatedProposal", () => {
  test("flags the assistant turn that claims a proposal it never called for", () => {
    const flagged = messagesWithFabricatedProposal(
      [
        { id: "u1", parts: [textPart("Actualiza el saldo")], role: "user" },
        assistantMessage("a1", [textPart(PRODUCTION_INCIDENT)]),
      ],
      false,
    );

    expect([...flagged]).toEqual(["a1"]);
  });

  test("never flags a turn that really called a proposal tool", () => {
    // The whole point: the card is there, so the sentence is true. This is the
    // normal path and it must stay silent.
    const flagged = messagesWithFabricatedProposal(
      [assistantMessage("a1", [textPart(PRODUCTION_INCIDENT), proposalPart()])],
      false,
    );

    expect([...flagged]).toEqual([]);
  });

  test("counts a proposal tool part in ANY state, not only a finished one", () => {
    // A stream that died mid-call still means the model asked for a real
    // proposal; the fabrication this guards against calls nothing at all.
    const started = {
      input: {},
      state: "input-streaming",
      toolCallId: "call-1",
      type: "tool-propose_early_repayment",
    } as unknown as UIMessage["parts"][number];

    expect([
      ...messagesWithFabricatedProposal(
        [assistantMessage("a1", [textPart("He preparado la propuesta."), started])],
        false,
      ),
    ]).toEqual([]);
  });

  test("a read-only tool does not excuse the claim", () => {
    const readPart = {
      input: {},
      output: {},
      state: "output-available",
      toolCallId: "call-1",
      type: "tool-get_financial_context",
    } as unknown as UIMessage["parts"][number];

    expect([
      ...messagesWithFabricatedProposal(
        [assistantMessage("a1", [textPart("He preparado la propuesta."), readPart])],
        false,
      ),
    ]).toEqual(["a1"]);
  });

  test("leaves the in-flight message alone while it streams", () => {
    // Mid-stream the prose can land before the tool call: judging it then would
    // flash an accusation and take it back, which is worse than being late.
    const messages = [
      assistantMessage("a1", [textPart("He preparado la propuesta.")]),
      assistantMessage("a2", [textPart("He preparado la propuesta.")]),
    ];

    expect([...messagesWithFabricatedProposal(messages, true)]).toEqual(["a1"]);
    expect([...messagesWithFabricatedProposal(messages, false)]).toEqual(["a1", "a2"]);
  });

  test("never flags the user's own words", () => {
    // The user may well type «he preparado la propuesta»; only the assistant can
    // fabricate the app's ceremony.
    expect([
      ...messagesWithFabricatedProposal(
        [{ id: "u1", parts: [textPart("He preparado la propuesta")], role: "user" }],
        false,
      ),
    ]).toEqual([]);
  });

  test("reads every text part of the turn, not just the first", () => {
    expect([
      ...messagesWithFabricatedProposal(
        [
          assistantMessage("a1", [
            textPart("Voy a mirar tus deudas."),
            textPart("Ya está: he preparado la propuesta."),
          ]),
        ],
        false,
      ),
    ]).toEqual(["a1"]);
  });
});
