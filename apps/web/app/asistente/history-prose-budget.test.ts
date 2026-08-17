import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  DROPPED_ATTACHMENT_NOTE,
  DROPPED_TURNS_NOTE,
  fitHistoryToBudget,
  historySizes,
  TRUNCATED_TEXT_MARKER,
} from "./history-prose-budget";

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function attachmentCard(id: string, fileName: string, rows: number): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "data-attachment-extraction",
        data: {
          fileName,
          result: {
            status: "valid",
            data: {
              documentType: "positions",
              warnings: [],
              positions: Array.from({ length: rows }, (_, index) => ({
                currency: "EUR",
                marketValueEur: index + 1,
                name: `Posición ${index} ${"x".repeat(100)}`,
                ticker: `T${index}`,
                units: 1,
              })),
            },
          },
        },
      },
    ],
  } as unknown as UIMessage;
}

function textOf(messages: readonly UIMessage[]): string {
  return JSON.stringify(messages);
}

const WIDE = { attachmentChars: 256_000, maxMessages: 40, proseChars: 200_000 };

describe("fitHistoryToBudget (#1408) · el caso reportado", () => {
  /**
   * The report, verbatim in shape: Jorge attaches a 425-row amortisation table, the
   * assistant recites it, and the NEXT turn is refused forever because one answer
   * outgrew the whole conversation's budget. There is no older turn to drop here —
   * which is exactly why dropping turns alone could never have fixed it.
   */
  it("deja pasar el turno aunque UNA sola respuesta exceda el presupuesto", () => {
    const recitation = Array.from(
      { length: 425 },
      (_, index) =>
        `| 1-jul.-${2026 + index} | 3.610,00 | 1.204,55 | 2.405,45 | 187.412,90 |`,
    ).join("\n");
    const messages = [
      userMessage("u1", "te adjunto el cuadro de amortización"),
      assistantMessage("a1", recitation),
      userMessage("u2", "¿cuánto pago en 2030?"),
    ];
    expect(historySizes(messages).proseChars).toBeGreaterThan(16_000);

    const fit = fitHistoryToBudget(messages, { ...WIDE, proseChars: 16_000 });

    // Nothing is refused, and the question that was just asked is still there.
    expect(historySizes(fit.messages).proseChars).toBeLessThanOrEqual(16_000);
    expect(textOf(fit.messages)).toContain("¿cuánto pago en 2030?");
    // At this ceiling the price is the whole attachment turn — which is why the
    // ceiling itself had to be raised too, and not only the mode of failure.
    expect(fit.droppedMessageIds).toEqual(["u1", "a1"]);
    expect(textOf(fit.messages)).toContain(DROPPED_TURNS_NOTE);
  });

  it("con el presupuesto real de flash-lite no toca nada de eso", () => {
    // The other half of the fix: at 200 000 characters the recitation is ordinary
    // prose, so the shrink never runs and the assistant remembers its own answer.
    const recitation = Array.from(
      { length: 425 },
      (_, index) =>
        `| 1-jul.-${2026 + index} | 3.610,00 | 1.204,55 | 2.405,45 | 187.412,90 |`,
    ).join("\n");
    const messages = [
      userMessage("u1", "te adjunto el cuadro"),
      assistantMessage("a1", recitation),
      userMessage("u2", "¿cuánto pago en 2030?"),
    ];

    const fit = fitHistoryToBudget(messages, WIDE);

    expect(fit.messages).toEqual(messages);
    expect(fit.droppedMessageIds).toEqual([]);
    expect(fit.truncatedMessageIds).toEqual([]);
  });
});

describe("fitHistoryToBudget (#1408) · turnos completos", () => {
  it("tira los turnos más viejos enteros y conserva el que está en vuelo", () => {
    const messages = Array.from({ length: 6 }, (_, index) => [
      userMessage(`u${index}`, `pregunta ${index} ${"a".repeat(3_000)}`),
      assistantMessage(`a${index}`, `respuesta ${index} ${"b".repeat(3_000)}`),
    ]).flat();

    const fit = fitHistoryToBudget(messages, { ...WIDE, proseChars: 14_000 });

    expect(historySizes(fit.messages).proseChars).toBeLessThanOrEqual(14_000);
    // The pair survives as a pair: no answer is left without its question.
    const kept = textOf(fit.messages);
    expect(kept).toContain("pregunta 5");
    expect(kept).toContain("respuesta 5");
    expect(kept).not.toContain("pregunta 0");
    expect(kept).not.toContain("respuesta 0");
    expect(fit.droppedMessageIds).toContain("u0");
    expect(fit.droppedMessageIds).toContain("a0");
    // And the model is told, so it does not answer about them from memory.
    expect(kept).toContain(DROPPED_TURNS_NOTE);
  });

  it("nunca deja el historial sin el mensaje que el usuario acaba de enviar", () => {
    // A budget below one turn: the only way out that is not a refusal is to cut
    // text — the message the user just sent included.
    const messages = [userMessage("u1", "x".repeat(50_000))];

    const fit = fitHistoryToBudget(messages, { ...WIDE, proseChars: 2_000 });

    expect(fit.messages.length).toBe(1);
    expect(fit.messages[0]!.id).toBe("u1");
    expect(historySizes(fit.messages).proseChars).toBeLessThanOrEqual(2_000);
    expect(fit.truncatedMessageIds).toEqual(["u1"]);
    expect(textOf(fit.messages)).toContain(TRUNCATED_TEXT_MARKER);
  });

  it("no recorta la nota que explica lo que falta", () => {
    const messages = Array.from({ length: 8 }, (_, index) => [
      userMessage(`u${index}`, `pregunta ${index} ${"a".repeat(4_000)}`),
      assistantMessage(`a${index}`, `respuesta ${index} ${"b".repeat(4_000)}`),
    ]).flat();

    const fit = fitHistoryToBudget(messages, { ...WIDE, proseChars: 9_000 });

    // The note is what forbids answering from its own earlier prose (ADR 0048), so
    // making room by cutting IT would defeat the shrink.
    expect(textOf(fit.messages)).toContain(DROPPED_TURNS_NOTE);
  });
});

describe("fitHistoryToBudget (#1408) · cuántos mensajes y cuántas tarjetas", () => {
  it("recorta el número de mensajes por frontera de turno en vez de rechazar", () => {
    const messages = Array.from({ length: 30 }, (_, index) => [
      userMessage(`u${index}`, `pregunta ${index}`),
      assistantMessage(`a${index}`, `respuesta ${index}`),
    ]).flat();

    const fit = fitHistoryToBudget(messages, { ...WIDE, maxMessages: 10 });

    expect(fit.messages.length).toBeLessThanOrEqual(11); // 10 + la nota va dentro del primero
    expect(fit.messages.at(-1)!.id).toBe("a29");
    // The window opens on a question, never on an answer whose question was cut.
    expect(fit.messages[0]!.role).toBe("user");
    expect(fit.droppedMessageIds).toContain("u0");
  });

  it("acota un historial de MILES de mensajes sin quedarse a medir", () => {
    // The count ceiling used to REFUSE, so nothing below it ever saw a history like
    // this. Now it shrinks — and the order matters: measuring the serialized history
    // once per dropped turn over thousands of messages is the quadratic trap.
    const messages = Array.from({ length: 5_000 }, (_, index) =>
      index % 2 === 0
        ? userMessage(`u${index}`, `pregunta ${index}`)
        : assistantMessage(`a${index}`, `respuesta ${index}`),
    );

    const fit = fitHistoryToBudget(messages, WIDE);

    expect(fit.messages.length).toBeLessThanOrEqual(WIDE.maxMessages + 1);
    expect(textOf(fit.messages)).toContain("pregunta 4998");
  });

  it("tira las tarjetas de adjunto más viejas y conserva la de este turno", () => {
    const messages = [
      attachmentCard("a1", "enero.csv", 200),
      userMessage("u1", "y este otro"),
      attachmentCard("a2", "febrero.csv", 200),
      userMessage("u2", "¿qué ves en febrero?"),
    ];
    const oneCard = historySizes([messages[2]!]).attachmentChars;

    const fit = fitHistoryToBudget(messages, { ...WIDE, attachmentChars: oneCard });

    expect(historySizes(fit.messages).attachmentChars).toBeLessThanOrEqual(oneCard);
    const kept = textOf(fit.messages);
    expect(kept).toContain("febrero.csv");
    expect(kept).not.toContain("enero.csv");
    expect(fit.droppedAttachmentCards).toBe(1);
    // Only the user can hand the file over again — no tool can read it back.
    expect(kept).toContain(DROPPED_ATTACHMENT_NOTE);
  });

  it("no deja mensajes vacíos cuando la tarjeta era su única parte", () => {
    const messages = [
      attachmentCard("a1", "enero.csv", 200),
      userMessage("u1", "¿y ahora?"),
    ];

    const fit = fitHistoryToBudget(messages, { ...WIDE, attachmentChars: 10 });

    expect(fit.messages.every((message) => message.parts.length > 0)).toBe(true);
    expect(fit.droppedAttachmentCards).toBe(1);
  });
});

describe("historySizes (#1408)", () => {
  it("cobra las tarjetas de adjunto a su presupuesto, no al de la prosa", () => {
    const withCard = historySizes([attachmentCard("a1", "enero.csv", 100)]);

    expect(withCard.attachmentChars).toBeGreaterThan(1_000);
    // What is left of that message once the card is charged elsewhere is framing.
    expect(withCard.proseChars).toBeLessThan(200);
  });
});
