import { multiplyToMinor } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import type { ExtractedHoldingEvent } from "./attachment-extraction-contract";
import { resolveOperationTerms } from "./operation-terms";

/** The MyInvestor aportación of #1374, as the extractor hands it over. */
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

describe("resolveOperationTerms · the case of the issue", () => {
  it("keeps the printed participaciones and derives the price so the importe is exact", () => {
    const result = resolveOperationTerms(APORTACION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { terms } = result;
    expect(terms).toMatchObject({
      amountMinor: 125_00,
      currency: "EUR",
      executedAt: "2026-08-05",
      feesMinor: 0,
      units: "5.92",
      unitsDerived: false,
    });
    // 125 € ÷ 5,92 part. — the card prints it as 21,1149 €.
    expect(terms.pricePerUnit.startsWith("21.114864")).toBe(true);
    // The invariant: what is written folds back to the amount the document states.
    expect(multiplyToMinor(terms.units, terms.pricePerUnit)).toBe(125_00);
  });

  /**
   * The printed NAV (21,12 €) is a rounding of the real one, so over 5,92
   * participaciones it is ~3 cents off the stated total. That is a coherent
   * confirmation, not a mismatch: the card must not cry wolf on every real receipt.
   */
  it("says nothing when the printed NAV only differs by its own rounding", () => {
    const result = resolveOperationTerms(APORTACION);

    expect(result.ok && result.terms.notes).toEqual([]);
  });

  it("warns, without blocking, when the printed terms genuinely do not add up", () => {
    const result = resolveOperationTerms({
      ...APORTACION,
      pricePerUnit: { amount: 32.5, currency: "EUR" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terms.notes).toHaveLength(1);
    expect(result.terms.notes[0]).toContain("revisa la cifra");
    // And the operation still records the document's own participaciones and amount.
    expect(result.terms.units).toBe("5.92");
    expect(result.terms.amountMinor).toBe(125_00);
  });
});

describe("resolveOperationTerms · the commission", () => {
  it("nets a real commission off the amount so the cost basis keeps it", () => {
    const result = resolveOperationTerms({
      ...APORTACION,
      amount: 1000,
      fees: { amount: 1.5, currency: "EUR" },
      pricePerUnit: undefined,
      units: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terms.feesMinor).toBe(150);
    // (1.000 € − 1,50 €) ÷ 10 part.
    expect(result.terms.pricePerUnit).toBe("99.85");
    expect(result.terms.amountMinor).toBe(1_000_00);
  });

  it("carries a printed zero (the card says «comisión 0 €») and an absent one apart", () => {
    const zero = resolveOperationTerms(APORTACION);
    const absent = resolveOperationTerms({ ...APORTACION, fees: undefined });

    expect(zero.ok && zero.terms.feesMinor).toBe(0);
    expect(absent.ok && "feesMinor" in absent.terms).toBe(false);
  });

  it("refuses a commission that equals or exceeds the amount (a unit slip)", () => {
    const result = resolveOperationTerms({
      ...APORTACION,
      fees: { amount: 125, currency: "EUR" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("iguala o supera");
  });

  it("refuses a commission in another currency instead of inventing a rate", () => {
    const result = resolveOperationTerms({
      ...APORTACION,
      fees: { amount: 1.5, currency: "USD" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no convierto divisas");
  });
});

describe("resolveOperationTerms · a document with no participaciones", () => {
  /**
   * The amount with no quantity invented (#1374's acceptance case): the units come
   * from the price the document DOES print, so both figures are ink on the paper.
   */
  it("derives the participaciones from the printed unit price", () => {
    const result = resolveOperationTerms({
      ...APORTACION,
      units: undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terms.unitsDerived).toBe(true);
    expect(result.terms.pricePerUnit).toBe("21.12");
    // 125 € ÷ 21,12 €
    expect(result.terms.units.startsWith("5.9185")).toBe(true);
    expect(result.terms.notes[0]).toContain("no dice las participaciones");
  });

  /**
   * And with NEITHER printed, it refuses. A synthetic «1 participación al importe»
   * would be revalued to ONE share's NAV at the next ripple and swallow the amount —
   * the #1325 failure, which on an existing position has no honest encoding.
   */
  it("refuses when neither the quantity nor the price is printed, and says which is missing", () => {
    const result = resolveOperationTerms({
      ...APORTACION,
      pricePerUnit: undefined,
      units: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no las participaciones ni el precio por título");
    expect(result.error).toContain("Patrimonio");
  });

  it("refuses a printed price in another currency", () => {
    const result = resolveOperationTerms({
      ...APORTACION,
      pricePerUnit: { amount: 21.12, currency: "USD" },
      units: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no convierto divisas");
  });
});

describe("resolveOperationTerms · a document with no amount to write", () => {
  it("refuses a zero amount rather than record an empty operation", () => {
    const result = resolveOperationTerms({ ...APORTACION, amount: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cero");
  });

  it("reads a negative amount as its magnitude: the direction is the kind's, not the sign's", () => {
    const result = resolveOperationTerms({ ...APORTACION, amount: -125 });

    expect(result.ok && result.terms.amountMinor).toBe(125_00);
  });
});
