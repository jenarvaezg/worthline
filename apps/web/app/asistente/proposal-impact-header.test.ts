import { describe, expect, it } from "vitest";

import { proposalImpactHeader } from "./proposal-impact-header";

/** A stand-in formatter: the module is pure, so no `Intl` reaches these assertions. */
const euros = (minor: number) => `${minor / 100} EUR`;

describe("proposalImpactHeader", () => {
  it("leads with the totals and states the signed delta apart", () => {
    const header = proposalImpactHeader(
      { afterMinor: 297_185_00, beforeMinor: 297_060_00, deltaMinor: 125_00 },
      euros,
    );

    expect(header).toEqual({
      deltaLabel: "+125 EUR",
      headline: "Patrimonio neto 297060 EUR → 297185 EUR",
      increases: true,
      totalKnown: true,
    });
  });

  it("uses a real minus sign and the error tone when net worth falls", () => {
    const header = proposalImpactHeader(
      { afterMinor: 296_935_00, beforeMinor: 297_060_00, deltaMinor: -125_00 },
      euros,
    );

    expect(header.deltaLabel).toBe("−125 EUR");
    expect(header.increases).toBe(false);
  });

  /**
   * ADR 0048: a degraded net-worth read must never become a fabricated total. The card
   * says the delta it does know and admits the total is missing.
   */
  it("never fabricates a total when the read degraded", () => {
    const header = proposalImpactHeader(
      { afterMinor: null, beforeMinor: null, deltaMinor: 125_00 },
      euros,
    );

    expect(header.totalKnown).toBe(false);
    expect(header.headline).toBe(
      "Impacto en el patrimonio: +125 EUR (total no disponible ahora)",
    );
    expect(header.headline).not.toContain("Patrimonio neto");
  });

  it("hangs the estimate caption off the DELTA, which is what a ripple can move", () => {
    const header = proposalImpactHeader(
      { afterMinor: 297_185_00, beforeMinor: 297_060_00, deltaMinor: 125_00 },
      euros,
      { caption: "estimado sobre la operación" },
    );

    expect(header.deltaLabel).toBe("+125 EUR · estimado sobre la operación");
    // The totals are read, not estimated: the caption stays off the headline.
    expect(header.headline).toBe("Patrimonio neto 297060 EUR → 297185 EUR");
  });

  it("carries the caption into the degraded line too", () => {
    const header = proposalImpactHeader(
      { afterMinor: null, beforeMinor: 100_00, deltaMinor: 125_00 },
      euros,
      { caption: "estimado" },
    );

    expect(header.totalKnown).toBe(false);
    expect(header.headline).toBe(
      "Impacto en el patrimonio: +125 EUR · estimado (total no disponible ahora)",
    );
  });

  it("treats a zero delta as an increase, so the tone stays neutral-positive", () => {
    expect(
      proposalImpactHeader({ afterMinor: 0, beforeMinor: 0, deltaMinor: 0 }, euros)
        .increases,
    ).toBe(true);
  });
});
