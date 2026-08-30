import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  holdingEventFromTyped,
  parseTypedHoldingEvent,
  typedHoldingEventGapMessage,
  typedHoldingEventInTurn,
} from "./typed-holding-event";

const TODAY = "2026-08-30";

function userMessage(text: string): UIMessage {
  return { id: "m1", parts: [{ text, type: "text" }], role: "user" };
}

/** The message that opened #1466, verbatim. */
const JORGE =
  "He comprado ahora 6 participaciones de IE00B43VDT70 por un total de 312,55€. " +
  "En total, sumando esas 6, tengo 21 participaciones";

describe("parseTypedHoldingEvent (#1466)", () => {
  it("reads the whole operation out of the message that opened the issue", () => {
    const reading = parseTypedHoldingEvent(JORGE, TODAY);

    expect(reading).toEqual({
      event: {
        amount: 312.55,
        currency: "EUR",
        declaredTotalUnits: "21",
        direction: "in",
        executedAt: TODAY,
        isin: "IE00B43VDT70",
        units: "6",
      },
      status: "read",
    });
  });

  it("derives the importe from the unit price when that is what was written", () => {
    const reading = parseTypedHoldingEvent(
      "Hoy he comprado 10 participaciones de IE00B43VDT70 a 52,09 € cada una",
      TODAY,
    );

    expect(reading).toEqual({
      event: {
        currency: "EUR",
        direction: "in",
        executedAt: TODAY,
        isin: "IE00B43VDT70",
        pricePerUnit: 52.09,
        units: "10",
      },
      status: "read",
    });
    // The importe the chain will record is the two written figures multiplied, never
    // a third figure the app supplies.
    expect(
      holdingEventFromTyped(reading.status === "read" ? reading.event : never(), "EUR"),
    ).toMatchObject({
      amount: 520.9,
      currency: "EUR",
      units: 10,
    });
  });

  it("reads a commission by its own word, so it never competes with the importe", () => {
    const reading = parseTypedHoldingEvent(
      "Ayer vendí 3 participaciones por 150,00 € con 1,50 € de comisión",
      TODAY,
    );

    expect(reading).toEqual({
      event: {
        amount: 150,
        currency: "EUR",
        direction: "out",
        executedAt: "2026-08-29",
        fees: 1.5,
        units: "3",
      },
      status: "read",
    });
  });

  it("resolves an explicit date, and refuses a date-shaped token that is no day", () => {
    expect(
      parseTypedHoldingEvent("El 12/08/2026 compré 6 part. por 312,55 €", TODAY),
    ).toMatchObject({
      event: { executedAt: "2026-08-12" },
      status: "read",
    });
    expect(
      parseTypedHoldingEvent("El 30/02/2026 compré 6 part. por 312,55 €", TODAY),
    ).toEqual({
      missing: ["date"],
      status: "incomplete",
    });
  });

  it("fails closed with no date in the message: it never dates an operation itself", () => {
    expect(
      parseTypedHoldingEvent("He comprado 6 participaciones por 312,55 €", TODAY),
    ).toEqual({
      missing: ["date"],
      status: "incomplete",
    });
  });

  it("names the missing figure instead of encoding «1 participación al importe»", () => {
    expect(
      parseTypedHoldingEvent("Hoy he comprado por 312,55 € del fondo", TODAY),
    ).toEqual({
      missing: ["units"],
      status: "incomplete",
    });
    expect(
      parseTypedHoldingEvent("Hoy he comprado 6 participaciones del fondo", TODAY),
    ).toEqual({
      missing: ["money"],
      status: "incomplete",
    });
  });

  it("refuses two money figures it cannot tell apart", () => {
    expect(
      parseTypedHoldingEvent("Hoy he comprado 6 part. por 312,55 € y 120,00 €", TODAY),
    ).toEqual({ missing: ["ambiguous_amount"], status: "incomplete" });
  });

  it("refuses two quantities of participaciones for one operation", () => {
    expect(
      parseTypedHoldingEvent(
        "Hoy he comprado 6 participaciones y 4 participaciones por 312,55 €",
        TODAY,
      ),
    ).toEqual({ missing: ["ambiguous_units"], status: "incomplete" });
  });

  it("says nothing at all about a message that states no operation", () => {
    expect(parseTypedHoldingEvent("¿Cómo va mi cartera este mes?", TODAY)).toEqual({
      status: "absent",
    });
  });

  it("leaves the currency unmarked when the message does not write one", () => {
    const reading = parseTypedHoldingEvent(
      "Hoy he comprado 6 participaciones por 312,55",
      TODAY,
    );

    expect(reading).toMatchObject({
      event: { amount: 312.55, currency: null },
      status: "read",
    });
  });

  it("relays every gap in one sentence, never one round trip per gap", () => {
    const message = typedHoldingEventGapMessage(["units", "date"]);

    expect(message).toContain("participaciones");
    expect(message).toContain("fecha");
  });
});

describe("typedHoldingEventInTurn (#1466)", () => {
  it("reads THIS turn's user message and nothing before it", () => {
    const reading = typedHoldingEventInTurn(
      [
        userMessage("Hoy he comprado 4 participaciones por 100,00 €"),
        { id: "a1", parts: [{ text: "Vale", type: "text" }], role: "assistant" },
        userMessage(JORGE),
      ],
      TODAY,
    );

    expect(reading).toMatchObject({ event: { units: "6" }, status: "read" });
  });

  it("is absent when the turn has no user message", () => {
    expect(typedHoldingEventInTurn([], TODAY)).toEqual({ status: "absent" });
  });
});

function never(): never {
  throw new Error("expected a read event");
}
