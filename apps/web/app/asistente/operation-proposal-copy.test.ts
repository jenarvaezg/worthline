import { describe, expect, it } from "vitest";

import {
  operationDestinationLine,
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
