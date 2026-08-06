/**
 * Naming a holding in a chip (#1375): unambiguous or nothing.
 */

import {
  holdingLookupQuery,
  MAX_HOLDING_REFERENCE,
  type NamedHoldingCandidate,
  pickNamedHolding,
} from "@web/asistente/named-holding";
import { describe, expect, it } from "vitest";

const PLAN: NamedHoldingCandidate = {
  id: "wl_hld_00000000000000000000000000000001",
  label: "N5396 - Myinvestor Indexado Global PP",
};
const FONDO_A: NamedHoldingCandidate = {
  id: "wl_hld_00000000000000000000000000000002",
  label: "Fondo A",
};
const FONDO_B: NamedHoldingCandidate = {
  id: "wl_hld_00000000000000000000000000000003",
  label: "Fondo B",
};

describe("holdingLookupQuery", () => {
  it("strips the guillemets the model copies from its own prose", () => {
    expect(holdingLookupQuery("«N5396 - Myinvestor Indexado Global PP»")).toBe(
      "N5396 - Myinvestor Indexado Global PP",
    );
  });

  it("folds a line break inside the name into a space", () => {
    expect(holdingLookupQuery("N5396 -\nMyinvestor")).toBe("N5396 - Myinvestor");
  });

  it("keeps the parentheses a real label carries", () => {
    expect(holdingLookupQuery("Cartera Metal (2024)")).toBe("Cartera Metal (2024)");
    expect(holdingLookupQuery("«Cartera Metal (2024)»")).toBe("Cartera Metal (2024)");
  });

  it("strips a balanced pair of square brackets, the model's other quote", () => {
    expect(holdingLookupQuery("[Cartera Metal (2024)]")).toBe("Cartera Metal (2024)");
    // Unbalanced: part of the name, not a quote around it.
    expect(holdingLookupQuery("Cartera [Metal")).toBe("Cartera [Metal");
  });

  it("has nothing to look up for punctuation alone", () => {
    expect(holdingLookupQuery("«»")).toBeNull();
    expect(holdingLookupQuery("   ")).toBeNull();
  });

  it("refuses a reference longer than any label", () => {
    expect(holdingLookupQuery("x".repeat(MAX_HOLDING_REFERENCE + 1))).toBeNull();
  });
});

describe("pickNamedHolding", () => {
  it("resolves the name of a single live holding", () => {
    expect(pickNamedHolding("N5396 - Myinvestor Indexado Global PP", [PLAN])).toBe(
      PLAN.id,
    );
  });

  it("prefers the holding whose label IS the name over the ones containing it", () => {
    const fondo: NamedHoldingCandidate = { id: "wl_hld_x", label: "Fondo" };
    expect(pickNamedHolding("fondo", [FONDO_A, fondo, FONDO_B])).toBe(fondo.id);
  });

  it("refuses an ambiguous name rather than opening the likeliest", () => {
    expect(pickNamedHolding("Fondo", [FONDO_A, FONDO_B])).toBeNull();
  });

  it("refuses a name two holdings carry verbatim", () => {
    expect(
      pickNamedHolding("Fondo A", [FONDO_A, { ...FONDO_B, label: "Fondo A" }]),
    ).toBeNull();
  });

  it("resolves a WORD of the label, which is how the model shortens a name", () => {
    expect(pickNamedHolding("Myinvestor", [PLAN, FONDO_A])).toBe(PLAN.id);
  });

  it("refuses a fragment that is not a word of any label", () => {
    // `find_holdings` is an unanchored substring match: «vest» hits this holding and
    // exactly one holding, which is not the same thing as naming it.
    expect(pickNamedHolding("vest", [PLAN])).toBeNull();
    expect(pickNamedHolding("ond", [FONDO_A])).toBeNull();
  });

  it("refuses a fragment too short to be a name at all", () => {
    expect(pickNamedHolding("A", [FONDO_A])).toBeNull();
  });

  it("still resolves a short name a holding carries verbatim", () => {
    const oro: NamedHoldingCandidate = { id: "wl_hld_oro", label: "Oro" };
    expect(pickNamedHolding("oro", [oro])).toBe(oro.id);
  });

  it("takes an identifier hit as an identifier, not as a word", () => {
    expect(
      pickNamedHolding("ES0000000001", [{ ...FONDO_A, matchedOn: "isin" as const }]),
    ).toBe(FONDO_A.id);
  });

  it("refuses a query so wide the search capped out", () => {
    expect(pickNamedHolding("Fondo", [FONDO_A], { truncated: true })).toBeNull();
  });

  it("refuses even an exact label on a capped page, where a twin may be missing", () => {
    const fondo: NamedHoldingCandidate = { id: "wl_hld_twin", label: "Fondo" };
    expect(pickNamedHolding("Fondo", [fondo, FONDO_A], { truncated: true })).toBeNull();
  });

  it("refuses a name nothing matches", () => {
    expect(pickNamedHolding("Fondo inventado", [])).toBeNull();
  });
});
