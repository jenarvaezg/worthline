import { describe, expect, test } from "vitest";

import {
  holdingTrashImpactHeader,
  holdingTrashWarnings,
} from "./holding-trash-card-model";
import type { HoldingTrashProposal } from "./holding-trash-proposal-contract";

// A pure formatter so the module's output is asserted without es-ES/Intl noise.
const fmt = (minor: number): string => `€${minor}`;

describe("holdingTrashImpactHeader (#1106)", () => {
  test("known total → antes → después headline, red delta when it falls", () => {
    const header = holdingTrashImpactHeader(
      { afterMinor: 750_000, beforeMinor: 1_000_000, deltaMinor: -250_000 },
      fmt,
    );
    expect(header).toEqual({
      deltaLabel: "−€250000",
      headline: "Patrimonio neto €1000000 → €750000",
      increases: false,
      totalKnown: true,
    });
  });

  test("a rise reads as ok (increases) with a + delta", () => {
    const header = holdingTrashImpactHeader(
      { afterMinor: 1_100_000, beforeMinor: 1_000_000, deltaMinor: 100_000 },
      fmt,
    );
    expect(header.increases).toBe(true);
    expect(header.deltaLabel).toBe("+€100000");
  });

  test("a degraded total never fabricates a figure", () => {
    const header = holdingTrashImpactHeader(
      { afterMinor: null, beforeMinor: null, deltaMinor: -250_000 },
      fmt,
    );
    expect(header.totalKnown).toBe(false);
    expect(header.headline).toBe(
      "Impacto en el patrimonio: −€250000 (total no disponible ahora)",
    );
  });
});

function proposalWith(overrides: Partial<HoldingTrashProposal>): HoldingTrashProposal {
  return {
    draft: { proposalId: "p" },
    duplicates: [],
    folio: "Propuesta de baja · A la papelera · reversible",
    impact: { afterMinor: 0, beforeMinor: 0, deltaMinor: 0 },
    lines: [],
    operation: "remove",
    orphanPairs: [],
    proposalType: "holding_removal",
    ...overrides,
  };
}

describe("holdingTrashWarnings (#1106)", () => {
  test("no warnings → empty list", () => {
    expect(holdingTrashWarnings(proposalWith({}))).toEqual([]);
  });

  test("orphan pair, shared ownership and duplicate render in a stable order", () => {
    const proposal = proposalWith({
      duplicates: [{ confidence: "weak", liveName: "Cuenta viva", name: "Cuenta" }],
      lines: [
        {
          contributionMinor: 0,
          detail: "1.000 €",
          holdingId: "wl_hld_1",
          instrumentLabel: "Inmueble",
          kind: "asset",
          name: "Piso",
          sharedOwnership: true,
        },
      ],
      orphanPairs: [{ assetName: "Piso", debtName: "Hipoteca" }],
    });
    expect(holdingTrashWarnings(proposal)).toEqual([
      "La deuda «Hipoteca» quedará sin su activo «Piso».",
      "«Piso» es de propiedad compartida.",
      "Al restaurar «Cuenta» habrá un duplicado con «Cuenta viva» (mismo nombre).",
    ]);
  });

  test("a strong duplicate is flagged as such", () => {
    const proposal = proposalWith({
      duplicates: [{ confidence: "strong", liveName: "Fondo vivo", name: "Fondo" }],
    });
    expect(holdingTrashWarnings(proposal)).toEqual([
      "Al restaurar «Fondo» habrá un duplicado con «Fondo vivo» (coincidencia fuerte).",
    ]);
  });
});
