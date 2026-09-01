import { userRefusal } from "@web/asistente/proposal-refusal";
import { typedHoldingEventGapMessage } from "@web/asistente/typed-holding-event";
import { describe, expect, test } from "vitest";

import { TOOL_DISCIPLINE_QUESTIONS } from "./golden-tool-discipline";
import { relaysTheRefusal } from "./golden-write-checks";
import type { AssistantAnswer } from "./graders";

function answer(over: Partial<AssistantAnswer> = {}): AssistantAnswer {
  return { text: "", toolCalls: [], toolResults: [], quickActions: [], ...over };
}

/** The refusal `propose_operation` answers a two-figure message with (#1753). */
const AMBIGUOUS_AMOUNT = userRefusal(
  "operation_fact_incomplete_in_message",
  typedHoldingEventGapMessage(["ambiguous_amount"]),
);

const refused = (text: string): AssistantAnswer =>
  answer({
    text,
    toolCalls: [{ input: {}, name: "propose_operation" }],
    toolResults: [{ name: "propose_operation", output: AMBIGUOUS_AMOUNT }],
  });

/** The terms `write-relays-the-refusal` grades its turn against. */
const TERMS = [
  "más de una cifra",
  "dos cifras",
  "dos importes",
  "cuál es el importe",
  "cuál de las dos",
  "qué importe",
  "cuál de los dos",
];

describe("relaysTheRefusal (#1753)", () => {
  test("passes the turn that names why worthline said no", () => {
    expect(
      relaysTheRefusal(
        refused(
          "No he podido anotarla: en tu mensaje hay dos cifras en euros y worthline no " +
            "sabe cuál es el importe de la compra. Escríbeme sólo ése y te la preparo.",
        ),
        TERMS,
      ).pass,
    ).toBe(true);
  });

  test("fails the turn that swallows the motive", () => {
    // Jose's turn, minus the lie: no fabricated card to catch, and the words that
    // unblocked him still never reach the screen from the prose.
    expect(
      relaysTheRefusal(
        refused("No he podido registrar la compra. Inténtalo de nuevo."),
        TERMS,
      ).pass,
    ).toBe(false);
  });

  test("stays silent when no lane wrote the user a refusal", () => {
    // Nothing was refused, so there is nothing to relay — the same silence
    // `noCeremonyOverRejection` keeps, and why the question carries a positive check
    // that a mute turn cannot pass.
    expect(
      relaysTheRefusal(answer({ text: "¿Cuál de las dos cifras es el importe?" }), TERMS)
        .pass,
    ).toBe(true);
  });
});

describe("the turn that obeys the prompt to the letter (#1753)", () => {
  /**
   * The compliant answer is the refusal's own sentence, because that is what the prompt
   * now asks for: «dilo en ese mismo turno con las palabras de ese error». Both of the
   * question's prose checks have to pass on it — a harness that failed the most
   * obedient turn there is would be measuring its own vocabulary, which is the trap
   * `README.md` warns about twice.
   */
  const question = TOOL_DISCIPLINE_QUESTIONS.find(
    (candidate) => candidate.id === "write-relays-the-refusal",
  )!;

  test("scores every check on a turn that quotes worthline verbatim", () => {
    const failed = question
      .grade(refused(`worthline no me deja anotarla: «${AMBIGUOUS_AMOUNT.message}»`))
      .filter((check) => !check.pass);

    expect(failed).toEqual([]);
  });
});
