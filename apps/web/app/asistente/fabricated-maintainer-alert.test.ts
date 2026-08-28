import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";

import {
  claimsRaisedMaintainerAlert,
  fabricatesMaintainerAlert,
  messagesWithFabricatedMaintainerAlert,
} from "./fabricated-maintainer-alert";
import {
  inFlightAlertPart,
  raisedAlertPart,
  refusedAlertPart,
} from "./proposal-part-fixtures";

/** The prose the model actually emitted in production (#1525), trimmed. */
const PRODUCTION_INCIDENT =
  "Entiendo tu frustración y te confirmo que he registrado la incidencia técnicamente " +
  "como una limitación del sistema.\n\nDicho esto, como asistente no puedo abrir " +
  "tickets de producto ni levantar alertas sobre «ausencia de funcionalidades».";

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, parts, role: "assistant" };
}

function textPart(text: string): UIMessage["parts"][number] {
  return { text, type: "text" };
}

describe("claimsRaisedMaintainerAlert", () => {
  test("recognises the claim the model made in production", () => {
    expect(claimsRaisedMaintainerAlert(PRODUCTION_INCIDENT)).toBe(true);
  });

  test("recognises the other ways of asserting one exists", () => {
    for (const text of [
      "He registrado la incidencia.",
      "Te he levantado una alerta con el descuadre.",
      "Ya he abierto una incidencia sobre esto.",
      "He trasladado el aviso al desarrollador.",
      "Se ha registrado la incidencia con tu caso.",
      "La incidencia queda registrada para el mantenedor.",
      "El ticket está abierto.",
      "Registré la incidencia esta mañana.",
    ]) {
      expect(claimsRaisedMaintainerAlert(text), text).toBe(true);
    }
  });

  test("does NOT fire on the offer, which is the honest turn", () => {
    // The present tense is the answer the refusal message is trying to produce: it
    // asks rather than promises. A note here would be noise on the path that works.
    for (const text of [
      "¿Quieres que registre una incidencia?",
      "Puedo levantar una alerta si me das el saldo que esperabas.",
      "Voy a registrar la incidencia en cuanto me digas la fecha.",
      "Si me confirmas la cifra, levanto la alerta.",
    ]) {
      expect(claimsRaisedMaintainerAlert(text), text).toBe(false);
    }
  });

  test("does NOT fire on the model NEGATING the claim", () => {
    // Precisely the sentence the history note provokes: without the negation guard
    // the two seams would feed each other for the rest of the conversation.
    for (const text of [
      "No he registrado ninguna incidencia: la herramienta la rechazó.",
      "Tienes razón, no he abierto ningún ticket.",
      "No puedo levantar una alerta sobre una funcionalidad que no existe.",
    ]) {
      expect(claimsRaisedMaintainerAlert(text), text).toBe(false);
    }
  });

  test("leaves the honest turn that registers something ELSE alone", () => {
    // Review's case: one sentence to the splitter (a semicolon does not end one), the
    // claim verb and the ceremony's noun both inside it, and entirely honest. What
    // keeps it out is the noun riding next to the verb rather than anywhere in reach.
    expect(
      claimsRaisedMaintainerAlert(
        "He registrado tu operación; sobre la alerta, no puedo levantarla.",
      ),
    ).toBe(false);
    expect(
      claimsRaisedMaintainerAlert(
        "He registrado la amortización de abril; una incidencia no puedo abrirla.",
      ),
    ).toBe(false);
  });

  test("leaves ordinary sentences alone", () => {
    // «Aviso» on its own is an everyday word, and the claim verbs are everyday verbs.
    for (const text of [
      "Te aviso de que el saldo pintado no cuadra con el del banco.",
      "He registrado la amortización del 10 de abril.",
      "He creado la posición con los datos que me diste.",
      "He abierto el histórico para comparar los dos cierres.",
    ]) {
      expect(claimsRaisedMaintainerAlert(text), text).toBe(false);
    }
  });
});

describe("fabricatesMaintainerAlert", () => {
  test("flags the turn that was refused and narrated success anyway", () => {
    expect(
      fabricatesMaintainerAlert(
        assistantMessage("m1", [refusedAlertPart(), textPart(PRODUCTION_INCIDENT)]),
      ),
    ).toBe(true);
  });

  test("flags the turn that claimed one without calling the tool at all", () => {
    expect(
      fabricatesMaintainerAlert(
        assistantMessage("m1", [textPart("He registrado la incidencia.")]),
      ),
    ).toBe(true);
  });

  test("stays silent when the alert really was raised", () => {
    expect(
      fabricatesMaintainerAlert(
        assistantMessage("m1", [
          raisedAlertPart(),
          textPart("He levantado una alerta con el descuadre."),
        ]),
      ),
    ).toBe(false);
  });

  test("stays silent while the call is still in flight", () => {
    // The tool writes through the control plane BEFORE it returns, so a stream that
    // died after the write leaves an alert that really exists. Accusing there would
    // make the app the liar.
    expect(
      fabricatesMaintainerAlert(
        assistantMessage("m1", [
          inFlightAlertPart(),
          textPart("He registrado la incidencia."),
        ]),
      ),
    ).toBe(false);
  });

  test("stays silent on a turn that mentions no alert at all", () => {
    expect(
      fabricatesMaintainerAlert(
        assistantMessage("m1", [
          textPart("Tu patrimonio neto es de 412.300,00 € a 21 de agosto."),
        ]),
      ),
    ).toBe(false);
  });

  test("never judges a user turn", () => {
    expect(
      fabricatesMaintainerAlert({
        id: "u1",
        parts: [textPart("Has abierto una incidencia, ¿cierto?")],
        role: "user",
      }),
    ).toBe(false);
  });
});

describe("messagesWithFabricatedMaintainerAlert", () => {
  test("collects the offending turns by id", () => {
    const flagged = messagesWithFabricatedMaintainerAlert(
      [
        assistantMessage("m1", [textPart("Te leo el saldo.")]),
        assistantMessage("m2", [
          refusedAlertPart(),
          textPart("He registrado la incidencia."),
        ]),
      ],
      false,
    );
    expect([...flagged]).toEqual(["m2"]);
  });

  test("leaves the streaming turn alone until it finishes", () => {
    // Prose can land before the tool call within one turn, so judging it early would
    // flash an accusation and then withdraw it.
    const messages = [assistantMessage("m1", [textPart("He registrado la incidencia.")])];
    expect([...messagesWithFabricatedMaintainerAlert(messages, true)]).toEqual([]);
    expect([...messagesWithFabricatedMaintainerAlert(messages, false)]).toEqual(["m1"]);
  });
});
