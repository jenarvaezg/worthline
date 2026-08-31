import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";

import {
  fabricatedCeremonyGuard,
  LEAVE_IN_FLIGHT_ALONE,
  messagesWithFabricatedCeremony,
} from "./fabricated-ceremony";
import {
  fabricatesMaintainerAlert,
  messagesWithFabricatedMaintainerAlert,
} from "./fabricated-maintainer-alert";
import {
  fabricatedProposalIn,
  messagesWithFabricatedProposal,
} from "./fabricated-proposal";
import {
  inFlightAlertPart,
  proposalCardPart,
  raisedAlertPart,
  refusedAlertPart,
  rejectedProposalPart,
  toolPart,
} from "./proposal-part-fixtures";

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, parts, role: "assistant" };
}

function textPart(text: string): UIMessage["parts"][number] {
  return { text, type: "text" };
}

/**
 * The two ceremonies, described only by what a test needs to drive them: the claim the
 * model made, the lane that DID deliver, and the lane that answered delivering nothing.
 *
 * Table-driven on purpose. The mechanics below are shared now, so a regression in them
 * would land on both guards at once — and the whole reason #1254 keeps being cited in
 * this corner is that two copies of one rule drift apart in silence.
 */
const CEREMONIES = [
  {
    claim: "He preparado la propuesta.",
    delivered: proposalCardPart,
    fabricated: (message: UIMessage) => fabricatedProposalIn(message) !== null,
    flagged: (messages: UIMessage[], streaming: boolean) => [
      ...messagesWithFabricatedProposal(messages, streaming).keys(),
    ],
    name: "propuesta",
    refused: rejectedProposalPart,
  },
  {
    claim: "He registrado la incidencia.",
    delivered: raisedAlertPart,
    fabricated: fabricatesMaintainerAlert,
    flagged: (messages: UIMessage[], streaming: boolean) => [
      ...messagesWithFabricatedMaintainerAlert(messages, streaming),
    ],
    name: "alerta al mantenedor",
    refused: refusedAlertPart,
  },
] as const;

describe("la guarda se apaga por el RESULTADO de la llamada, nunca por la llamada (#1468)", () => {
  for (const ceremony of CEREMONIES) {
    describe(ceremony.name, () => {
      test("una lane que respondió sin entregar nada NO excusa la afirmación", () => {
        // El agujero de #1468, en una frase: si la guarda se desactivara por la
        // PRESENCIA de la llamada, se apagaría justo en el caso peor — el modelo lo
        // intentó, worthline dijo no, y él narró el éxito.
        expect(
          ceremony.fabricated(
            assistantMessage("a1", [textPart(ceremony.claim), ceremony.refused()]),
          ),
        ).toBe(true);
      });

      test("solo la entrega de verdad la apaga", () => {
        expect(
          ceremony.fabricated(
            assistantMessage("a1", [textPart(ceremony.claim), ceremony.delivered()]),
          ),
        ).toBe(false);
      });

      test("una entrega real convive con un rechazo y sigue apagándola", () => {
        expect(
          ceremony.fabricated(
            assistantMessage("a1", [
              textPart(ceremony.claim),
              ceremony.refused(),
              ceremony.delivered(),
            ]),
          ),
        ).toBe(false);
      });

      test("una lane de otra ceremonia no la apaga", () => {
        // Cruzado a propósito: la lane de la otra ceremonia respondió y entregó lo
        // suyo, que no es lo que este turno afirmó.
        const otherDelivery = CEREMONIES.find((c) => c.name !== ceremony.name)!.delivered;
        expect(
          ceremony.fabricated(
            assistantMessage("a1", [textPart(ceremony.claim), otherDelivery()]),
          ),
        ).toBe(true);
      });

      test("deja en paz el turno en vuelo mientras se emite", () => {
        const messages = [assistantMessage("a1", [textPart(ceremony.claim)])];
        expect(ceremony.flagged(messages, true)).toEqual([]);
        expect(ceremony.flagged(messages, false)).toEqual(["a1"]);
      });

      test("nunca acusa al usuario de fabricar la ceremonia de la app", () => {
        expect(
          ceremony.fabricated({
            id: "u1",
            parts: [textPart(ceremony.claim)],
            role: "user",
          }),
        ).toBe(false);
      });
    });
  }
});

describe("fabricatedCeremonyGuard", () => {
  const deliversOk = (part: UIMessage["parts"][number]) =>
    "output" in part && (part as { output: unknown }).output === "ok";
  const guard = fabricatedCeremonyGuard({
    claims: (prose) => prose.includes("hecho"),
    delivers: deliversOk,
    interrupted: "interrupted",
    lanes: (part) => part.type === "tool-do_it",
    never: "no-call",
    rejected: "rejected",
  });

  test("no hay veredicto sin afirmación", () => {
    expect(guard(assistantMessage("a1", [textPart("¿quieres que lo haga?")]))).toBeNull();
  });

  test("distingue las tres formas de no haber entregado nada", () => {
    expect(guard(assistantMessage("a1", [textPart("hecho")]))).toBe("no-call");
    expect(
      guard(
        assistantMessage("a1", [
          textPart("hecho"),
          toolPart("tool-do_it", { output: "no", state: "output-available" }),
        ]),
      ),
    ).toBe("rejected");
    expect(
      guard(
        assistantMessage("a1", [
          textPart("hecho"),
          toolPart("tool-do_it", { state: "input-available" }),
        ]),
      ),
    ).toBe("interrupted");
  });

  test("una lane cortada puede eximir el turno cuando la ceremonia lo pide", () => {
    // La asimetría de la alerta (#1525): la tool escribe ANTES de devolver, así que de
    // una llamada cortada no se puede afirmar que no exista la alerta.
    const exempting = fabricatedCeremonyGuard({
      claims: (prose) => prose.includes("hecho"),
      delivers: deliversOk,
      interrupted: LEAVE_IN_FLIGHT_ALONE,
      lanes: (part) => part.type === "tool-do_it",
      never: "no-call",
      rejected: "rejected",
    });
    expect(
      exempting(
        assistantMessage("a1", [
          textPart("hecho"),
          toolPart("tool-do_it", { state: "input-available" }),
        ]),
      ),
    ).toBeNull();
  });

  test("un error de la tool tampoco es una entrega", () => {
    // `output-error` / `output-denied` respondieron, y no entregaron nada.
    expect(
      guard(
        assistantMessage("a1", [
          textPart("hecho"),
          toolPart("tool-do_it", { errorText: "boom", state: "output-error" }),
        ]),
      ),
    ).toBe("rejected");
  });
});

describe("messagesWithFabricatedCeremony", () => {
  const verdictFor = (message: UIMessage): "bad" | null =>
    message.parts.some(
      (part) => part.type === "text" && (part as { text: string }).text === "malo",
    )
      ? "bad"
      : null;

  test("recoge los turnos por id, en orden", () => {
    expect([
      ...messagesWithFabricatedCeremony(
        [
          assistantMessage("a1", [textPart("malo")]),
          assistantMessage("a2", [textPart("bueno")]),
          assistantMessage("a3", [textPart("malo")]),
        ],
        false,
        verdictFor,
      ),
    ]).toEqual([
      ["a1", "bad"],
      ["a3", "bad"],
    ]);
  });

  test("exime SOLO el último mensaje, y solo mientras se emite", () => {
    const messages = [
      assistantMessage("a1", [textPart("malo")]),
      assistantMessage("a2", [textPart("malo")]),
    ];
    expect([
      ...messagesWithFabricatedCeremony(messages, true, verdictFor).keys(),
    ]).toEqual(["a1"]);
    expect([
      ...messagesWithFabricatedCeremony(messages, false, verdictFor).keys(),
    ]).toEqual(["a1", "a2"]);
  });

  test("una alerta en vuelo no es un veredicto: el mapa queda vacío", () => {
    // La asimetría de #1525 vista desde el barrido: la tool persiste antes de
    // devolver, así que un stream cortado deja una alerta que puede existir de verdad.
    expect(
      messagesWithFabricatedCeremony(
        [
          assistantMessage("a1", [
            textPart("He registrado la incidencia."),
            inFlightAlertPart(),
          ]),
        ],
        false,
        (message) => (fabricatesMaintainerAlert(message) ? true : null),
      ).size,
    ).toBe(0);
  });
});
