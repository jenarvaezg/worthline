import { userRefusal } from "@web/asistente/proposal-refusal";
import { typedHoldingEventGapMessage } from "@web/asistente/typed-holding-event";
import { describe, expect, test } from "vitest";

import { TOOL_DISCIPLINE_QUESTIONS } from "./golden-tool-discipline";
import { relaysTheRefusal, transfersBetween } from "./golden-write-checks";
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

describe("transfersBetween (#1801)", () => {
  const FUNDS = {
    name: "find_holdings",
    output: {
      matches: [
        { id: "wl_hld_europa", label: "Fondo indexado Europa", object: "holding" },
        { id: "wl_hld_rf", label: "Fondo indexado renta fija", object: "holding" },
        { id: "wl_hld_small", label: "ETF MSCI Small Cap", object: "holding" },
      ],
    },
  };
  const transfer = (originHoldingId: string, destinationHoldingId: string) => ({
    input: { destinationHoldingId, originHoldingId },
    name: "propose_transfer",
  });
  const grade = (calls: AssistantAnswer["toolCalls"]) =>
    transfersBetween(
      answer({ toolCalls: calls, toolResults: [FUNDS] }),
      ["europa"],
      ["renta fija"],
    );

  test("passes the traspaso from the paper's origin to the paper's destination", () => {
    const result = grade([transfer("wl_hld_europa", "wl_hld_rf")]);

    expect(result).toEqual({
      name: "el traspaso va del fondo de origen al de destino que nombra el documento",
      pass: true,
    });
  });

  test("fails the swapped pair, and says which way it went", () => {
    const result = grade([transfer("wl_hld_rf", "wl_hld_europa")]);

    expect(result.pass).toBe(false);
    expect(result.name).toContain(
      "(traspaso: Fondo indexado renta fija → Fondo indexado Europa)",
    );
  });

  test("fails a turn that never asked for a traspaso", () => {
    // Silence is not a right answer on a question whose sanctioned move is to write.
    const result = grade([
      { input: { holdingId: "wl_hld_rf" }, name: "propose_operation" },
    ]);

    expect(result.pass).toBe(false);
    expect(result.name).toContain("(traspaso: ninguno)");
  });

  test("passes a turn that corrected course after the lane refused its first pick", () => {
    // The lane refuses a holding whose ISIN is not the paper's and names the right one
    // (#1800): a wrong first pick never becomes a card, and following the refusal is the
    // design working — the reading `attachment-imports-the-broker-statement` makes of a
    // turn that tries the reconcile lane first.
    const result = grade([
      transfer("wl_hld_europa", "wl_hld_small"),
      transfer("wl_hld_europa", "wl_hld_rf"),
    ]);

    expect(result.pass).toBe(true);
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
