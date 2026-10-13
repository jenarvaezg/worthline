import { describe, expect, it } from "vitest";

import {
  PASTED_REEMBOLSO,
  pastedTransferReceipt,
} from "./pasted-transfer-receipt-fixture";
import { parseTypedHoldingEvent } from "./typed-holding-event";
import { operationReceiptFigures } from "./typed-operation-receipt";

/**
 * Jose's paste, verbatim (#1751): the confirmation his bank prints, copied into the
 * chat. It is the fixture the whole module answers to, so it is kept character for
 * character — the runs of spaces ARE the table.
 */
const PASTED_CONFIRMATION = `CONFIRMACIÓN DE OPERACIÓN DE VALORES DATOS PERSONALES                  Titular   JOSE ENRIQUE NARVAEZ GAGO                                              Cta. asociada   XXXX XXXX XXXX XXXX XXXX 2991         Divisa   EUR                                                 País           Cuenta   XXXX-XXXX-XX-XXXXXX2992                                 DETALLE OPERACIÓN        Mercado         Valor                         FONDOS EXTR         VANGUARD EUROPEAN STOCK INDEX EUR ACC - Código ISIN: IE0007987708 Sociedad Gestora: VANGUARD ASSET MANAGEMENT Entidad Depositaria:BROWN BROTHERS HARRIMAN INVESTOR SERVICES LTD.             Operación         Referencia Operación                                             SUSCRIPCION I.I.C.         155826246/346                                                     Fecha Operación         Fecha Valor                                             01/09/2026         02/09/2026                                                     Número de títulos/Participaciones         Precio Bruto         Importe Bruto                                               1.51         42.7996 EUR         64.62 EUR                                           Comisiones         Gastos         Tasas e Impuestos                                               0.00 EUR         0.00 EUR         0.00 EUR                                           Spread Aplicado Cambio Divisa             0.00 EUR   Retención Origen         Retención Destino         Importe Efectivo Neto (1)         Tipo de Cambio                                                 0.00 EUR         0.00 EUR         64.62 EUR         1.00 EUR                                 (1) El Importe Neto ha sido anotado en su cuenta corriente en la fecha indicada.`;

describe("operationReceiptFigures", () => {
  it("reads every figure of a pasted confirmation off its own label", () => {
    expect(operationReceiptFigures(PASTED_CONFIRMATION)).toEqual({
      executedAt: "2026-09-01",
      fees: 0,
      grossAmount: 64.62,
      netAmount: 64.62,
      pricePerUnit: 42.7996,
      units: "1.51",
    });
  });

  it("takes the date from «Fecha Operación» and never from «Fecha Valor»", () => {
    const figures = operationReceiptFigures(PASTED_CONFIRMATION);
    expect(figures?.executedAt).toBe("2026-09-01");
    expect(figures?.executedAt).not.toBe("2026-09-02");
  });

  it("reads a label/value pair printed inline with a colon", () => {
    const figures = operationReceiptFigures(
      "Participaciones: 6\nImporte: 312,55 €\nFecha operación: 12/08/2026",
    );
    expect(figures).toEqual({
      executedAt: "2026-08-12",
      netAmount: 312.55,
      units: "6",
    });
  });

  it("reports the gross, the efectivo and the commission as printed, composing nothing", () => {
    // #1836: the receipt does not know the direction, so it cannot say whether the fee
    // was added or netted off. It reports the paper; the dictated door composes the
    // importe with the kind (`holdingEventFromTyped`).
    const figures = operationReceiptFigures(
      ["Importe Bruto\tComisiones\tEfectivo", "1.000,00 EUR\t9,95 EUR\t990,05 EUR"].join(
        "\n",
      ),
    );
    expect(figures).toEqual({ fees: 9.95, grossAmount: 1000, netAmount: 990.05 });
  });

  it("adds up every cost line the paper prints", () => {
    const figures = operationReceiptFigures(
      ["Comisiones\tGastos\tTasas e Impuestos", "9,95 EUR\t1,00 EUR\t0,20 EUR"].join(
        "\n",
      ),
    );
    expect(figures?.fees).toBe(11.15);
  });

  it("drops a row whose labels and figures do not line up, rather than guessing", () => {
    // Three labels, two figures: pairing by position would put the importe on the price.
    expect(
      operationReceiptFigures(
        ["Participaciones\tPrecio\tImporte", "6\t312,55 EUR"].join("\n"),
      ),
    ).toBeNull();
  });

  it("is not a receipt when the text is ordinary prose", () => {
    expect(
      operationReceiptFigures(
        "He comprado hoy 6 participaciones de IE00B43VDT70 por 312,55 €",
      ),
    ).toBeNull();
  });

  it("is not a receipt on a single labelled figure inside a sentence", () => {
    expect(operationReceiptFigures("Te paso el importe:  312,55 €")).toBeNull();
  });
});

describe("operationReceiptFigures, on a pasted traspaso (#1794)", () => {
  it("reads «Operación» with its text beside it, so the two dates pair with their labels", () => {
    // «Operación · REEMB.POR TRASPASO I · Fecha Operación · Fecha Valor» used to be one
    // run of four labels against two dates, dropped whole. The day of the operation is
    // the 14th; the 13th is the fecha valor, printed right after it.
    expect(operationReceiptFigures(PASTED_REEMBOLSO)?.executedAt).toBe("2026-08-14");
  });

  it("reads the whole block: the operation's name and the commission row included", () => {
    // «Gastos» prints its currency and no figure («0.00 EUR · EUR · 739.22 EUR»). That
    // cell is an empty VALUE, not a label: read as a label, it made the commission row
    // unequal and dropped it, and a commission nobody read is one nobody refuses.
    expect(operationReceiptFigures(PASTED_REEMBOLSO)).toEqual({
      executedAt: "2026-08-14",
      fees: 0,
      grossAmount: 739.22,
      netAmount: 739.22,
      operation: "REEMB.POR TRASPASO I",
      pricePerUnit: 12.0003,
      units: "61.6",
    });
  });

  it("settles a three-decimal figure by the block's own decimal mark (#1794)", () => {
    const pointBlock = pastedTransferReceipt({
      commission: "0.00",
      gross: "739.22",
      net: "739.22",
      operation: "REEMB.POR TRASPASO I",
      operationDay: "14/08/2026",
      price: "19.8700",
      units: "37.203",
      valueDay: "13/08/2026",
    });

    expect(operationReceiptFigures(pointBlock)).toMatchObject({ units: "37.203" });
    expect(operationReceiptFigures(pointBlock)?.unsettled).toBeUndefined();
  });

  it("names the figure it could not settle, read the es-ES way, when the block says nothing (#1794)", () => {
    const silentBlock = pastedTransferReceipt({
      commission: "0",
      gross: "739",
      net: "739",
      operation: "REEMB.POR TRASPASO I",
      operationDay: "14/08/2026",
      price: "20",
      units: "37.203",
      valueDay: "13/08/2026",
    });

    expect(operationReceiptFigures(silentBlock)).toMatchObject({
      units: "37203",
      unsettled: [{ field: "units", printed: "37.203" }],
    });
  });

  it("never lets «Operación» swallow the next header and shift the figures onto it", () => {
    // A header row and its values, flattened: «Nº Títulos» is the next COLUMN, not the
    // operation's name. Taking it as one would pair the price with 6 and the importe
    // with 52,09 — an equal run of wrong figures. Unequal, it is dropped as always.
    expect(
      operationReceiptFigures(
        "Operación  Nº Títulos  Precio  Importe  SUSCRIPCION  6  52,09 EUR  312,55 EUR",
      ),
    ).toBeNull();
  });
});

describe("parseTypedHoldingEvent, on a pasted confirmation", () => {
  it("reads Jose's paste instead of refusing it as ambiguous (#1751)", () => {
    expect(parseTypedHoldingEvent(PASTED_CONFIRMATION, "2026-09-01")).toEqual({
      event: {
        amount: 64.62,
        currency: "EUR",
        direction: "in",
        executedAt: "2026-09-01",
        fees: 0,
        grossAmount: 64.62,
        isin: "IE0007987708",
        pricePerUnit: 42.7996,
        units: "1.51",
      },
      status: "read",
    });
  });

  it("still reads the dictated sentence of #1466 exactly as before", () => {
    expect(
      parseTypedHoldingEvent(
        "He comprado ahora 6 participaciones de IE00B43VDT70 por un total de 312,55€. " +
          "En total, sumando esas 6, tengo 21 participaciones",
        "2026-08-12",
      ),
    ).toEqual({
      event: {
        amount: 312.55,
        currency: "EUR",
        declaredTotalUnits: "21",
        direction: "in",
        executedAt: "2026-08-12",
        isin: "IE00B43VDT70",
        units: "6",
      },
      status: "read",
    });
  });

  it("names the gap when a pasted table states no quantity", () => {
    expect(
      parseTypedHoldingEvent(
        [
          "Importe Bruto\tComisiones",
          "312,55 EUR\t0,00 EUR",
          "Fecha operación: 12/08/2026",
        ].join("\n"),
        "2026-08-12",
      ),
    ).toEqual({ missing: ["units"], status: "incomplete" });
  });

  it("never dates a pasted table that carries no day", () => {
    expect(
      parseTypedHoldingEvent(
        ["Participaciones\tImporte Bruto", "6\t312,55 EUR"].join("\n"),
        "2026-08-12",
      ),
    ).toEqual({ missing: ["date"], status: "incomplete" });
  });

  it("reads a pasted reembolso and keeps its direction as a veto", () => {
    const reading = parseTypedHoldingEvent(
      [
        "REEMBOLSO I.I.C.",
        "Participaciones\tPrecio\tImporte Bruto",
        "6\t52,09 EUR\t312,55 EUR",
        "Fecha operación: 12/08/2026",
      ].join("\n"),
      "2026-08-12",
    );
    expect(reading).toMatchObject({ event: { direction: "out" }, status: "read" });
  });
});
