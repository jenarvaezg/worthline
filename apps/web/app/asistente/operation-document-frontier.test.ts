import { describe, expect, it } from "vitest";

import type {
  ExtractedDocument,
  ExtractedHoldingEvent,
} from "./attachment-extraction-contract";
import {
  holdingEventInContext,
  OPERATION_DOCUMENT_REQUIRED_MESSAGE,
  resolveOperationEvent,
} from "./operation-document-frontier";

/**
 * The document-only frontier of `propose_operation` (#1374). The literal case is the
 * MyInvestor aportación that opened the issue: `05/08/2026 · APORTACION P.P. ·
 * MYINVESTOR INDEXADO SP 500 PP · TIT: 5.92 · PRE: 21.12 · 125.00 EUR`, commission 0.
 */
const APORTACION: ExtractedHoldingEvent = {
  amount: 125,
  currency: "EUR",
  date: "2026-08-05",
  fees: { amount: 0, currency: "EUR" },
  isin: "ES0173516115",
  kind: "other",
  label: "APORTACION P.P. MYINVESTOR INDEXADO SP 500 PP",
  pricePerUnit: { amount: 21.12, currency: "EUR" },
  units: 5.92,
};

/**
 * The validated union is BRANDED so an unvalidated literal cannot pass for an
 * extraction; a fixture stands in for the extractor's own output.
 */
function validated(event: ExtractedHoldingEvent): ExtractedDocument {
  return {
    documentType: "holding_event",
    event,
    warnings: [],
  } as unknown as ExtractedDocument;
}

const DOCUMENT = {
  documentType: "holding_event" as const,
  event: APORTACION,
  warnings: [],
};

describe("holdingEventInContext", () => {
  it("takes the LAST holding-event document and ignores the other kinds", () => {
    const positions = {
      documentType: "positions",
      holdings: [],
      warnings: [],
    } as unknown as ExtractedDocument;
    const older = validated({ ...APORTACION, amount: 90 });

    expect(
      holdingEventInContext([positions, older, validated(APORTACION)])?.event.amount,
    ).toBe(125);
    expect(holdingEventInContext([positions])).toBeNull();
    expect(holdingEventInContext([])).toBeNull();
  });
});

describe("resolveOperationEvent · without a validated document", () => {
  it("refuses and ROUTES: upload the receipt, or use the reconcile / import", () => {
    const result = resolveOperationEvent({ kind: "contribution" }, null);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe("operation_document_required");
    expect(result.error.message).toBe(OPERATION_DOCUMENT_REQUIRED_MESSAGE);
    expect(result.error.message).toMatch(/importar-extracto/);
    expect(result.error.message).toMatch(/justificante|confirmación/i);
  });
});

describe("resolveOperationEvent · the fact is the document's", () => {
  it("accepts the claim that matches, and hands back the EXTRACTION's event", () => {
    const result = resolveOperationEvent(
      {
        amount: 125,
        currency: "EUR",
        date: "2026-08-05",
        fees: 0,
        isin: "es0173516115",
        kind: "contribution",
        pricePerUnit: 21.12,
        units: 5.92,
      },
      DOCUMENT,
    );

    expect(result).toEqual({ ok: true, event: APORTACION });
  });

  it("accepts a bare claim: the fact does not need relaying at all", () => {
    expect(resolveOperationEvent({ kind: "contribution" }, DOCUMENT)).toEqual({
      ok: true,
      event: APORTACION,
    });
  });

  it("tolerates a whole-euro relay of an amount with cents", () => {
    const withCents = {
      ...DOCUMENT,
      event: { ...APORTACION, amount: 125.5 },
    };

    expect(resolveOperationEvent({ amount: 126, kind: "buy" }, withCents).ok).toBe(true);
  });

  /**
   * The mistake that opened the issue: the figure came from the PORTFOLIO (a 5.387 €
   * snapshot) and not from the paper. The refusal names what the document reads, so
   * the model does not guess again.
   */
  it("refuses an amount taken from somewhere other than the document", () => {
    const result = resolveOperationEvent(
      { amount: 5387, kind: "contribution" },
      DOCUMENT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe("operation_fact_not_in_document");
    expect(result.error.message).toContain("125");
    // es-ES leaves a four-digit figure ungrouped, which is what the model relayed.
    expect(result.error.message).toContain("5387");
  });

  it("refuses a date, a currency or an ISIN that the document does not carry", () => {
    for (const claim of [
      { date: "2026-08-04" },
      { currency: "USD" },
      { isin: "IE00B03HCZ61" },
    ]) {
      const result = resolveOperationEvent({ kind: "buy", ...claim }, DOCUMENT);
      expect(result.ok, JSON.stringify(claim)).toBe(false);
    }
  });

  /**
   * The invention this lane most has to fear: a quantity nobody printed becomes units
   * in the ledger forever, and every later sale inherits the error (#1315).
   */
  it("refuses participaciones the document never printed", () => {
    const noUnits = {
      ...DOCUMENT,
      event: { ...APORTACION, units: undefined, pricePerUnit: undefined },
    };

    const result = resolveOperationEvent({ kind: "buy", units: 5.92 }, noUnits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("no dice las participaciones");
  });

  it("refuses a quantity that disagrees with the printed one", () => {
    expect(resolveOperationEvent({ kind: "buy", units: 6.92 }, DOCUMENT).ok).toBe(false);
  });

  /**
   * The printed price is NOT compared when the document has one: what gets written is
   * `(importe − comisión) / participaciones`, so relaying either figure is legitimate.
   */
  it("accepts either the printed or the derived unit price, and refuses an invented one", () => {
    expect(resolveOperationEvent({ kind: "buy", pricePerUnit: 21.12 }, DOCUMENT).ok).toBe(
      true,
    );
    expect(
      resolveOperationEvent({ kind: "buy", pricePerUnit: 21.1149 }, DOCUMENT).ok,
    ).toBe(true);

    const noPrice = { ...DOCUMENT, event: { ...APORTACION, pricePerUnit: undefined } };
    expect(resolveOperationEvent({ kind: "buy", pricePerUnit: 21.12 }, noPrice).ok).toBe(
      false,
    );
  });

  it("refuses a commission that is not the printed one", () => {
    const result = resolveOperationEvent({ fees: 1.5, kind: "buy" }, DOCUMENT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("comisión");
  });
});

describe("resolveOperationEvent · direction", () => {
  it("leaves the direction to the model when the document pins none", () => {
    // `other` is what a securities trade confirmation gets (#1316): buy and sell both
    // pass, and the card prints the document's own label next to the word it chose.
    expect(resolveOperationEvent({ kind: "buy" }, DOCUMENT).ok).toBe(true);
    expect(resolveOperationEvent({ kind: "sell" }, DOCUMENT).ok).toBe(true);
  });

  it("refuses a sale read off a document the extraction pinned as an ingreso", () => {
    const deposit = { ...DOCUMENT, event: { ...APORTACION, kind: "deposit" as const } };

    expect(resolveOperationEvent({ kind: "contribution" }, deposit).ok).toBe(true);
    const result = resolveOperationEvent({ kind: "sell" }, deposit);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe("operation_kind_contradicts_document");
    expect(result.error.message).toContain(APORTACION.label);
  });

  it("refuses a purchase read off a withdrawal", () => {
    const withdrawal = {
      ...DOCUMENT,
      event: { ...APORTACION, kind: "withdrawal" as const },
    };

    expect(resolveOperationEvent({ kind: "sell" }, withdrawal).ok).toBe(true);
    expect(resolveOperationEvent({ kind: "buy" }, withdrawal).ok).toBe(false);
  });
});
