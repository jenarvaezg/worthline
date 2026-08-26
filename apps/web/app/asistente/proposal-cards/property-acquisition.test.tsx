import type { PropertyAcquisitionProposal } from "@web/asistente/property-acquisition-proposal-contract";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PropertyAcquisitionProposalCard } from "./property-acquisition";

/**
 * The acquisition card (#1563) in the MARKUP, which is where the user meets it.
 *
 * Rendered DIRECTLY, not through `AssistantLayer` — the level ADR 0088 names for a
 * card's own copy («a new card can be tested directly»); driving the whole layer is
 * the right level for the turn-to-card path and the wrong one for this.
 *
 * What is pinned here is the ceremony this lane rests on. It is allowed to be born
 * from evidence worthline could not validate (#1248) for exactly one reason — the
 * human eye validates a date and a price at a glance — and that reason only holds
 * if the card SHOWS both figures next to the ones they replace. A card printing
 * only the new pair would be asking somebody to confirm a rewrite of twenty-two
 * years of value without showing what is being rewritten.
 */

/** `Intl` uses a non-breaking space before €; assertions read the plain text. */
function plain(html: string): string {
  return html.replace(/(&#x27;|&#39;)/g, "'").replace(/[  ]/g, " ");
}

/** Jorge's flat: acquired 19 May 2004 for 150.253,03 €, not the day he typed it. */
function acquisitionProposal(): PropertyAcquisitionProposal {
  return {
    draft: { proposalId: "wl_prp_1563" },
    folio: "1 propuesta · 1 inmueble · 1 fecha de adquisición",
    notes: ["El histórico del inmueble empezará el 19/05/2004 en vez del 02/07/2026."],
    points: [
      {
        afterMinor: 150_253_03,
        beforeMinor: 233_000_00,
        dateKey: "2004-05-19",
        deltaMinor: -82_746_97,
        role: "acquisition_new",
      },
      {
        afterMinor: 210_000_00,
        beforeMinor: 210_000_00,
        dateKey: "2026-07-02",
        deltaMinor: 0,
        role: "acquisition_current",
      },
      {
        afterMinor: 233_000_00,
        beforeMinor: 233_000_00,
        dateKey: "2026-08-26",
        deltaMinor: 0,
        role: "today",
      },
    ],
    property: { id: "wl_hld_piso", name: "Piso de Plasencia" },
    proposalType: "property_acquisition",
    rows: [
      { after: "19/05/2004", before: "02/07/2026", label: "Fecha de adquisición" },
      { after: "150.253,03 €", before: "210.000,00 €", label: "Precio de adquisición" },
    ],
    summary: "Adquisición de «Piso de Plasencia»: 19/05/2004 · 150.253,03 €",
  };
}

function markupFor(
  proposal: PropertyAcquisitionProposal,
  gate: { mutationsDisabled: boolean; mutationsDisabledMessage: string } = {
    mutationsDisabled: false,
    mutationsDisabledMessage: "",
  },
): string {
  return plain(
    renderToStaticMarkup(
      <PropertyAcquisitionProposalCard {...gate} proposal={proposal} />,
    ),
  );
}

describe("the acquisition card (#1563)", () => {
  test("shows each figure next to the one it replaces", () => {
    const markup = markupFor(acquisitionProposal());

    expect(markup).toContain("Fecha de adquisición");
    expect(markup).toContain("02/07/2026");
    expect(markup).toContain("19/05/2004");
    expect(markup).toContain("Precio de adquisición");
    expect(markup).toContain("210.000,00 €");
    expect(markup).toContain("150.253,03 €");
  });

  test("names the fact and says what the rewrite reaches", () => {
    const markup = markupFor(acquisitionProposal());

    expect(markup).toContain("Adquisición del inmueble");
    expect(markup).toContain("Piso de Plasencia");
    expect(markup).toContain(
      "El histórico del inmueble empezará el 19/05/2004 en vez del 02/07/2026.",
    );
    expect(markup).toContain("1 propuesta · 1 inmueble · 1 fecha de adquisición");
  });

  test("says the property's name ONCE, in the headline (#1317)", () => {
    const markup = markupFor(acquisitionProposal());

    expect(markup.match(/Piso de Plasencia/g)).toHaveLength(1);
  });

  test("offers exactly one confirm and one discard", () => {
    const markup = markupFor(acquisitionProposal());

    expect(markup.match(/Confirmar/g)).toHaveLength(1);
    expect(markup.match(/Descartar/g)).toHaveLength(1);
  });

  test("prints the demo message and disables both buttons when writes are shut", () => {
    const markup = markupFor(acquisitionProposal(), {
      mutationsDisabled: true,
      mutationsDisabledMessage: "En la demo no se puede escribir.",
    });

    expect(markup).toContain("En la demo no se puede escribir.");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
