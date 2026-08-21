import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  parseTypedTransfer,
  typedTransferGapMessage,
  typedTransferInTurn,
} from "./typed-transfer";

const TODAY = "2026-08-21";

function userMessage(text: string): UIMessage {
  return { id: "m1", parts: [{ text, type: "text" }], role: "user" };
}

describe("parseTypedTransfer (#1482)", () => {
  it("reads the amount and the date of the case that opened the slice", () => {
    const reading = parseTypedTransfer(
      "He traspasado hoy 1.018,67 € del fondo World al fondo Emergentes",
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: { executedAt: TODAY, portion: { amountMinor: 101867, kind: "amount" } },
    });
  });

  it("takes the only bare number as the amount once the date is cut out", () => {
    const reading = parseTypedTransfer(
      "El 12/08/2026 traspasé 1018,67 del World al EM",
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: {
        executedAt: "2026-08-12",
        portion: { amountMinor: 101867, kind: "amount" },
      },
    });
  });

  it("resolves «ayer» against the clock it is given", () => {
    const reading = parseTypedTransfer("Ayer traspasé 500 € del World al EM", TODAY);

    expect(reading).toEqual({
      status: "read",
      transfer: {
        executedAt: "2026-08-20",
        portion: { amountMinor: 50000, kind: "amount" },
      },
    });
  });

  it("reads «todo» as its own intent, never as an importe", () => {
    const reading = parseTypedTransfer("Hoy he traspasado todo el World al EM", TODAY);

    expect(reading).toEqual({
      status: "read",
      transfer: { executedAt: TODAY, portion: { kind: "all" } },
    });
  });

  it("refuses a message with no date at all rather than dating it today", () => {
    const reading = parseTypedTransfer("He traspasado 1.018,67 € del World al EM", TODAY);

    expect(reading).toEqual({ missing: ["date"], status: "incomplete" });
  });

  it("refuses a message with no figure and no «todo»", () => {
    const reading = parseTypedTransfer("Hoy he traspasado del World al EM", TODAY);

    expect(reading).toEqual({ missing: ["amount"], status: "incomplete" });
  });

  it("names both gaps when neither the importe nor the date was written", () => {
    const reading = parseTypedTransfer("He traspasado del World al EM", TODAY);

    expect(reading.status).toBe("incomplete");
    expect(reading.status === "incomplete" && reading.missing).toEqual([
      "amount",
      "date",
    ]);
  });

  it("refuses two money figures instead of guessing which one left", () => {
    const reading = parseTypedTransfer(
      "Hoy traspasé 739,22 € del World y llegaron 740,72 € al EM",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["ambiguous_amount"], status: "incomplete" });
  });

  it("refuses «todo» and an importe together rather than picking one", () => {
    const reading = parseTypedTransfer(
      "Hoy traspasé todo el World, 1.018,67 €, al EM",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["conflicting_portion"], status: "incomplete" });
  });

  it("refuses two bare numbers, which could be an importe and a VL", () => {
    const reading = parseTypedTransfer(
      "Hoy traspasé 1018,67 a 12,3456 del World al EM",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["ambiguous_amount"], status: "incomplete" });
  });

  it("refuses a date-shaped token that is not a real day (#1395)", () => {
    const reading = parseTypedTransfer(
      "El 30/02/2026 traspasé 1.000 € del World al EM",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["date"], status: "incomplete" });
  });

  it("reads an ISO date and a percentage does not become an importe", () => {
    const reading = parseTypedTransfer(
      "2026-08-12: traspasé 1.018,67 € del World (comisión 0 %) al EM",
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: {
        executedAt: "2026-08-12",
        portion: { amountMinor: 101867, kind: "amount" },
      },
    });
  });

  it("refuses a zero importe: nothing was traspasado", () => {
    const reading = parseTypedTransfer("Hoy traspasé 0 € del World al EM", TODAY);

    expect(reading).toEqual({ missing: ["amount"], status: "incomplete" });
  });
});

describe("typedTransferGapMessage (#1482)", () => {
  it("asks for every gap in ONE sentence, never one round trip per gap", () => {
    const message = typedTransferGapMessage(["amount", "date"]);

    expect(message).toContain("no he visto cuánto se ha traspasado");
    expect(message).toContain("no he visto la fecha");
    expect(message).toContain("; y ");
  });

  it("routes the two-importes case to the screen that has a field for each", () => {
    expect(typedTransferGapMessage(["ambiguous_amount"])).toContain("«Traspasar»");
  });

  it("never says worthline cannot do it (#1524)", () => {
    for (const gap of [
      "amount",
      "date",
      "ambiguous_amount",
      "conflicting_portion",
    ] as const) {
      expect(typedTransferGapMessage([gap])).not.toMatch(/worthline no/i);
      expect(typedTransferGapMessage([gap])).toMatch(/te preparo el traspaso/i);
    }
  });
});

describe("typedTransferInTurn (#1482)", () => {
  it("reads the LAST user message and ignores the assistant's prose", () => {
    const reading = typedTransferInTurn(
      [
        userMessage("Hoy traspasé 999,00 € del World al EM"),
        { id: "a1", parts: [{ text: "1.018,67 €", type: "text" }], role: "assistant" },
        userMessage("Hoy traspasé 1.018,67 € del World al EM"),
      ],
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: { executedAt: TODAY, portion: { amountMinor: 101867, kind: "amount" } },
    });
  });

  it("never reaches back into an earlier user turn for the figure", () => {
    const reading = typedTransferInTurn(
      [
        userMessage("Hoy traspasé 1.018,67 € del World al EM"),
        {
          id: "a1",
          parts: [{ text: "¿de qué fondo?", type: "text" }],
          role: "assistant",
        },
        userMessage("del World al EM"),
      ],
      TODAY,
    );

    expect(reading.status).toBe("incomplete");
  });
});
