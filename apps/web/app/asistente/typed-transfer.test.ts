import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  PASTED_REEMBOLSO,
  PASTED_SUSCRIPCION,
  pastedTransferReceipt,
} from "./pasted-transfer-receipt-fixture";
import { transferOutput } from "./proposal-parsers/fixtures";
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

  it.each([
    "traspasa todo",
    "Traspasa todas las participaciones del World al EM",
    "Lo traspaso entero al EM",
  ])("«%s» is the whole position, still waiting for its day", (text) => {
    expect(parseTypedTransfer(text, TODAY)).toEqual({
      missing: ["date"],
      status: "incomplete",
    });
  });

  it("«ahora» does not date a traspaso: the day has to be named (#1798)", () => {
    expect(parseTypedTransfer("Ahora traspaso 500 € del World al EM", TODAY)).toEqual({
      missing: ["date"],
      status: "incomplete",
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

  it("reads a message with no figure, no date and no «todo» as stating nothing (#1798)", () => {
    // Not «incomplete»: the word «traspaso» is not one of the things a traspaso is made
    // of — «Sí, procede con la creación y el traspaso» says it too — and only a message
    // that states nothing lets the walk reach the figures written before it.
    expect(parseTypedTransfer("He traspasado del World al EM", TODAY)).toEqual({
      status: "absent",
    });
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

  it("reads the participaciones next to the importe, and then the VL is ours to derive (#1544)", () => {
    const reading = parseTypedTransfer(
      "Hoy he traspasado 37,203 participaciones (739,22 €) del World al EM",
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: {
        executedAt: TODAY,
        portion: { amountMinor: 73922, kind: "units", units: "37.203" },
      },
    });
  });

  it("reads the abbreviated form and does not confuse it with the importe", () => {
    const reading = parseTypedTransfer(
      "Hoy traspasé 34,8032023 part. por 739,22 € del World al EM",
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: {
        executedAt: TODAY,
        portion: { amountMinor: 73922, kind: "units", units: "34.8032023" },
      },
    });
  });

  it("the participaciones do not become the importe when the euros are bare", () => {
    // Two bare numbers used to be ambiguous; one of them is now MARKED as
    // participaciones, so what is left is a single figure and it reads cleanly.
    const reading = parseTypedTransfer(
      "Hoy traspasé 37,203 participaciones por 1018,67 del World al EM",
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: {
        executedAt: TODAY,
        portion: { amountMinor: 101867, kind: "units", units: "37.203" },
      },
    });
  });

  it("refuses participaciones with no importe beside them", () => {
    // Units alone derive nothing: the VL comes from the importe they were worth.
    const reading = parseTypedTransfer(
      "Hoy traspasé 37,203 participaciones del World al EM",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["amount"], status: "incomplete" });
  });

  it("refuses two participaciones figures instead of guessing which leg they are", () => {
    const reading = parseTypedTransfer(
      "Hoy traspasé 37,203 participaciones del World y entraron 51,08 participaciones en el EM por 739,22 €",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["ambiguous_units"], status: "incomplete" });
  });

  it("refuses «todo» together with participaciones, like «todo» with an importe", () => {
    const reading = parseTypedTransfer(
      "Hoy traspasé todo el World, 37,203 participaciones, al EM",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["conflicting_portion"], status: "incomplete" });
  });
});

describe("parseTypedTransfer, on a pasted confirmation (#1794)", () => {
  it("reads the bank's block instead of refusing its four euro figures as ambiguous", () => {
    expect(parseTypedTransfer(PASTED_REEMBOLSO, TODAY)).toEqual({
      status: "read",
      transfer: {
        executedAt: "2026-08-14",
        portion: { amountMinor: 73_922, kind: "units", units: "61.6" },
      },
    });
  });

  it("takes the participaciones of a suscripción block as the ones that ARRIVED", () => {
    // The paper of the half that entered: its participaciones are the destination's,
    // and the origin's are left for its own price to divide.
    expect(parseTypedTransfer(PASTED_SUSCRIPCION, TODAY)).toEqual({
      status: "read",
      transfer: {
        destinationUnits: "50.98",
        executedAt: "2026-08-14",
        portion: { amountMinor: 73_922, kind: "amount" },
      },
    });
  });

  it("refuses a block that charged a commission, and sends it to the screen", () => {
    const reading = parseTypedTransfer(
      pastedTransferReceipt({
        commission: "1.50",
        gross: "739.22",
        net: "737.72",
        operation: "REEMB.POR TRASPASO I",
        operationDay: "14/08/2026",
        price: "12.0003",
        units: "61.60",
        valueDay: "13/08/2026",
      }),
      TODAY,
    );

    expect(reading).toEqual({ missing: ["fee"], status: "incomplete" });
    expect(typedTransferGapMessage(["fee"])).toContain("comisión");
    expect(typedTransferGapMessage(["fee"])).toContain("«Traspasar»");
  });

  /** The reembolso block with three-decimal participaciones and the other figures given. */
  function reembolsoWith(figures: {
    units: string;
    price: string;
    gross: string;
    commission: string;
  }) {
    return pastedTransferReceipt({
      ...figures,
      net: figures.gross,
      operation: "REEMB.POR TRASPASO I",
      operationDay: "14/08/2026",
      valueDay: "13/08/2026",
    });
  }

  it("reads «37.203» as decimal when the block's own figures write the decimal with a point", () => {
    // «739.22 EUR» settles it: this paper writes decimals with a point, so «37.203» is
    // thirty-seven participaciones and change, not thirty-seven thousand.
    const reading = parseTypedTransfer(
      reembolsoWith({
        commission: "0.00",
        gross: "739.22",
        price: "19.8700",
        units: "37.203",
      }),
      TODAY,
    );

    expect(reading).toMatchObject({
      status: "read",
      transfer: { portion: { amountMinor: 73_922, kind: "units", units: "37.203" } },
    });
  });

  it("reads «37.203» as thousands when the block writes its decimals with a comma", () => {
    const reading = parseTypedTransfer(
      reembolsoWith({
        commission: "0,00",
        gross: "739,22",
        price: "0,0199",
        units: "37.203",
      }),
      TODAY,
    );

    expect(reading).toMatchObject({
      status: "read",
      transfer: { portion: { kind: "units", units: "37203" } },
    });
  });

  it("refuses «37.203» by name when nothing in the block says which mark is the decimal", () => {
    const reading = parseTypedTransfer(
      reembolsoWith({ commission: "0", gross: "739", price: "20", units: "37.203" }),
      TODAY,
    );

    expect(reading).toEqual({
      missing: ["unsettled_decimal"],
      status: "incomplete",
      unsettledFigure: "37.203",
    });
    const message = typedTransferGapMessage(["unsettled_decimal"], "37.203");
    expect(message).toContain("«37.203»");
    expect(message).toContain("coma decimal");
  });

  it("never dates the traspaso with the fecha valor when the block labels no other", () => {
    // The person copied the block from «Fecha Valor» on. Its day is the one the money
    // settled, and borrowing it as the operation's would date the pair a day off.
    const reading = parseTypedTransfer(
      "Fecha Valor  13/08/2026  Número de Participaciones  Valor Liquidativo  Importe Bruto  61.60  12.0003 EUR  739.22 EUR",
      TODAY,
    );

    expect(reading).toEqual({ missing: ["date"], status: "incomplete" });
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

  it("routes the two-participaciones case to the screen too", () => {
    expect(typedTransferGapMessage(["ambiguous_units"])).toContain("«Traspasar»");
  });

  it("never says worthline cannot do it (#1524)", () => {
    for (const gap of [
      "amount",
      "date",
      "ambiguous_amount",
      "ambiguous_units",
      "conflicting_portion",
      "fee",
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
});

describe("typedTransferInTurn: the figures last until a card spends them (#1798)", () => {
  const WRITTEN = "Hoy he traspasado 1.018,67 € del World al EM";

  function assistantText(text: string): UIMessage {
    return { id: "a1", parts: [{ text, type: "text" }], role: "assistant" };
  }

  it("«sí, procede» after a legible message reads THAT message, and says it was an earlier one", () => {
    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        assistantText("¿Creo antes el fondo de destino?"),
        userMessage("Sí, procede con la creación y el traspaso"),
      ],
      TODAY,
    );

    expect(reading).toEqual({
      earlierMessage: WRITTEN,
      status: "read",
      transfer: { executedAt: TODAY, portion: { amountMinor: 101867, kind: "amount" } },
    });
  });

  it("a message of chat in between changes nothing", () => {
    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        assistantText("No encuentro el fondo de destino."),
        userMessage("¿Lo ves?"),
        assistantText("Sí, ya lo veo."),
        userMessage("Vale, procede"),
      ],
      TODAY,
    );

    expect(reading).toMatchObject({
      earlierMessage: WRITTEN,
      status: "read",
      transfer: { portion: { amountMinor: 101867 } },
    });
  });

  it("stops at a traspaso card already drawn, so «hazlo otra vez» does not repeat it", () => {
    // Confirmed or not, the card was born of that reading and spent it.
    const card = {
      input: {},
      output: transferOutput(),
      state: "output-available",
      toolCallId: "call-1",
      type: "tool-propose_transfer",
    } as unknown as UIMessage["parts"][number];

    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        {
          id: "a1",
          parts: [{ text: "Aquí tienes:", type: "text" }, card],
          role: "assistant",
        },
        userMessage("Hazlo otra vez"),
      ],
      TODAY,
    );

    expect(reading).toEqual({ status: "absent" });
  });

  it("a refused call is no card, and spends nothing", () => {
    const refusal = {
      input: {},
      output: { error: "transfer_not_in_message", message: "…" },
      state: "output-available",
      toolCallId: "call-1",
      type: "tool-propose_transfer",
    } as unknown as UIMessage["parts"][number];

    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        { id: "a1", parts: [refusal], role: "assistant" },
        userMessage("Sí, procede"),
      ],
      TODAY,
    );

    expect(reading).toMatchObject({ earlierMessage: WRITTEN, status: "read" });
  });

  it("an incomplete last message is told what IT lacks, never filled from an earlier one", () => {
    const reading = typedTransferInTurn(
      [
        userMessage("El 12/08/2026 traspasé todo el World al EM"),
        assistantText("¿Cuánto fue?"),
        userMessage("Fueron 739,22 €"),
      ],
      TODAY,
    );

    expect(reading).toEqual({ missing: ["date"], status: "incomplete" });
  });

  it("resolves «ayer» in an earlier message against the clock of THIS turn, as before", () => {
    const reading = typedTransferInTurn(
      [userMessage("Ayer traspasé 500 € del World al EM"), userMessage("Sí, procede")],
      TODAY,
    );

    expect(reading).toMatchObject({
      status: "read",
      transfer: { executedAt: "2026-08-20" },
    });
  });

  it("an identifier written in between is not a figure: the ISIN and the plan code are transparent", () => {
    // The incident's own detour: the person typed the destination's ISIN because the
    // assistant could not find it. Its digits are not an importe.
    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        assistantText("No encuentro el fondo de destino."),
        userMessage("El ISIN es IE00B4L5Y983, y el del plan N5394"),
        userMessage("Sí, procede"),
      ],
      TODAY,
    );

    expect(reading).toMatchObject({ earlierMessage: WRITTEN, status: "read" });
  });

  it("«¿lo ves ahora?» is transparent: «ahora» is not the day of a traspaso", () => {
    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        assistantText("No encuentro el fondo de destino."),
        userMessage("¿Lo ves ahora?"),
      ],
      TODAY,
    );

    expect(reading).toMatchObject({ earlierMessage: WRITTEN, status: "read" });
  });

  it("«vale, todo claro, procede» is transparent: that «todo» is assent, not the participaciones", () => {
    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        assistantText("Te lo preparo como traspaso."),
        userMessage("Vale, todo claro, procede"),
      ],
      TODAY,
    );

    expect(reading).toMatchObject({
      earlierMessage: WRITTEN,
      status: "read",
      transfer: { portion: { amountMinor: 101867, kind: "amount" } },
    });
  });

  it.each([
    "todo bien, adelante",
    "Todo correcto, procede",
  ])("«%s» is assent too, and reaches back to the figures", (assent) => {
    const reading = typedTransferInTurn(
      [userMessage(WRITTEN), assistantText("¿Lo anoto?"), userMessage(assent)],
      TODAY,
    );

    expect(reading).toMatchObject({ earlierMessage: WRITTEN, status: "read" });
  });

  it("«traspasa todo» is still «todo», and it is the turn's own", () => {
    const reading = typedTransferInTurn(
      [
        userMessage(WRITTEN),
        assistantText("¿Lo anoto?"),
        userMessage("No, mejor traspasa todo, hoy"),
      ],
      TODAY,
    );

    expect(reading).toEqual({
      status: "read",
      transfer: { executedAt: TODAY, portion: { kind: "all" } },
    });
  });

  it("with nothing written at all, the reading is absent", () => {
    expect(typedTransferInTurn([userMessage("Sí, procede")], TODAY)).toEqual({
      status: "absent",
    });
  });
});
