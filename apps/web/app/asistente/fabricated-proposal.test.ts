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

  test("ignores text with no proposal vocabulary at all", () => {
    expect(claimsPreparedProposal("Tu patrimonio neto es de 412.000 €.")).toBe(false);
    expect(claimsPreparedProposal("")).toBe(false);
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
