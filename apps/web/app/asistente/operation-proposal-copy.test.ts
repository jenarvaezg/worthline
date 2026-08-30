import { describe, expect, it } from "vitest";

import {
  operationCurrencyAssumedNote,
  operationDeclaredTotalMismatch,
  operationDerivedAmountNote,
  operationDestinationLine,
  operationDictatedLine,
  operationDocumentLine,
  operationFactLine,
  operationKindLabel,
} from "./operation-proposal-copy";

/** es-ES puts NBSP/narrow-NBSP before the symbol; compare in plain spaces. */
function plain(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, " ");
}

describe("operationFactLine", () => {
  /**
   * The literal acceptance line of #1374: `05/08/2026 · compra · 5,92 part. ×
   * 21,1149 € · comisión 0 € · 125 €`. Every term is one the document printed or one
   * derived from two of them — and the position's value, the figure the improvised
   * path invented, appears nowhere.
   */
  it("prints the fact exactly as it will be written", () => {
    expect(
      plain(
        operationFactLine({
          amountMinor: 125_00,
          currency: "EUR",
          executedAt: "2026-08-05",
          feesMinor: 0,
          kind: "buy",
          pricePerUnit: "21.114864864864864865",
          units: "5.92",
        }),
      ),
    ).toBe("05/08/2026 · compra · 5,92 part. × 21,1149 € · comisión 0 € · 125 €");
  });

  it("says «aportación» when the paper does, and writes the same operation", () => {
    expect(operationKindLabel("contribution")).toBe("aportación");
    expect(
      plain(
        operationFactLine({
          amountMinor: 125_00,
          currency: "EUR",
          executedAt: "2026-08-05",
          feesMinor: 0,
          kind: "contribution",
          pricePerUnit: "21.1148",
          units: "5.92",
        }),
      ),
    ).toContain("· aportación ·");
  });

  it("omits the commission segment when the document printed none", () => {
    const line = plain(
      operationFactLine({
        amountMinor: 998_60,
        currency: "EUR",
        executedAt: "2026-07-24",
        kind: "sell",
        pricePerUnit: "16.0184",
        units: "62.3418",
      }),
    );

    expect(line).toBe("24/07/2026 · venta · 62,3418 part. × 16,0184 € · 998,60 €");
    expect(line).not.toContain("comisión");
  });

  it("keeps a non-EUR document in its own currency", () => {
    expect(
      plain(
        operationFactLine({
          amountMinor: 1_000_00,
          currency: "USD",
          executedAt: "2026-07-24",
          kind: "buy",
          pricePerUnit: "100",
          units: "10",
        }),
      ),
    ).toContain("10 part. × 100 USD");
  });
});

describe("operationDocumentLine / operationDestinationLine", () => {
  /**
   * #1373's rule applied to this card: the document's own text and the destination
   * holding are separate lines, so pointing at the wrong plan de pensiones is visible
   * before confirming instead of producing a card that agrees with itself.
   */
  it("separates what the document says from where it will be written", () => {
    expect(
      operationDocumentLine({
        isin: "ES0173516115",
        label: "APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP",
      }),
    ).toBe("APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP · ES0173516115");

    expect(
      operationDestinationLine({
        isin: "ES0173516115",
        name: "MyInvestor Indexado SP500",
      }),
    ).toBe("Anotar en «MyInvestor Indexado SP500» · ES0173516115");
  });

  it("prints only what exists: no ISIN, no dash standing in for one", () => {
    expect(operationDocumentLine({ label: "Compra fondo" })).toBe("Compra fondo");
    expect(operationDestinationLine({ name: "Cartera Metal" })).toBe(
      "Anotar en «Cartera Metal»",
    );
  });
});

describe("the dictated lane's own lines (#1466)", () => {
  /**
   * The ceremony of #1418 on this card: what worthline READ, verbatim, before anything
   * derived from it. If the parser read 312,55 € where the person wrote 312,05 €, this
   * is the line where it is caught — so it carries the figures he typed and not the
   * price the ledger will record.
   */
  it("echoes the figures the person typed, and nothing derived from them", () => {
    expect(
      plain(
        operationDictatedLine(
          {
            amount: 312.55,
            currency: "EUR",
            declaredTotalUnits: "21",
            direction: "in",
            executedAt: "2026-08-30",
            isin: "IE00B43VDT70",
            units: "6",
          },
          "EUR",
        ),
      ),
    ).toBe("30/08/2026 · 6 part. · 312,55 € · total que dices tener 21 · IE00B43VDT70");
  });

  it("prints the unit price when that is what was written instead of a total", () => {
    expect(
      plain(
        operationDictatedLine(
          {
            currency: "EUR",
            direction: "in",
            executedAt: "2026-08-30",
            pricePerUnit: 52.09,
            units: "10",
          },
          "EUR",
        ),
      ),
    ).toBe("30/08/2026 · 10 part. · a 52,09 € por participación");
  });

  /** #1401's rule: an unmarked currency is read, never assumed in silence. */
  it("says which currency it read into an unmarked importe", () => {
    const note = operationCurrencyAssumedNote("EUR", "Invesco Physical Silver ETC");

    expect(note).toContain("EUR");
    expect(note).toContain("Invesco Physical Silver ETC");
  });

  it("shows the multiplication behind an importe nobody typed", () => {
    expect(
      plain(
        operationDerivedAmountNote({
          amountMinor: 52090,
          currency: "EUR",
          pricePerUnit: 52.09,
          units: "10",
        }),
      ),
    ).toContain("10 × 52,09 € = 520,90 €");
  });

  /** #1422: a witness that does not hold is refused naming BOTH figures. */
  it("names the declared total and the resulting one when they disagree", () => {
    const refusal = operationDeclaredTotalMismatch({
      declaredTotalUnits: "30",
      holdingName: "Invesco Physical Silver ETC",
      unitsAfter: "21",
      unitsBefore: "15",
    });

    expect(refusal).toContain("30");
    expect(refusal).toContain("21");
    expect(refusal).toContain("15");
  });
});
