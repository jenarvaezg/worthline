import type { ExposureDimensionResult, ExposureLookthrough } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  assetClassLabel,
  coverageParts,
  formatExposureWeight,
  geographyForLens,
  geographyLabel,
  sectorForLens,
  sectorLabel,
  sectorStyleChips,
  sectorStyleForLens,
} from "./exposure-view";

/**
 * Pure among-state logic for the /patrimonio exposure section (PRD #539 S3, #543,
 * interaction-patterns §7): the client island is a thin shell, so which
 * pre-rendered geography breakdown a lens shows, how a `0..1` weight ratio prints
 * as an es-ES percent, how a slice key maps to a Spanish bucket label, and how a
 * coverage split orders into the three-way readout all live and unit-test here.
 */

const eur = (amountMinor: number) => ({ amountMinor, currency: "EUR" });

function dimension(
  overrides: Partial<ExposureDimensionResult> = {},
): ExposureDimensionResult {
  return {
    coverage: {
      classified: eur(0),
      notApplicable: eur(0),
      unknown: eur(0),
    },
    slices: [],
    ...overrides,
  };
}

describe("formatExposureWeight", () => {
  test("renders a decimal-string ratio as an es-ES percent", () => {
    expect(formatExposureWeight("0.4")).toBe("40 %");
    expect(formatExposureWeight("0.5")).toBe("50 %");
    expect(formatExposureWeight("1")).toBe("100 %");
  });

  test("rounds to a whole percent (weights are exact ratios, not display values)", () => {
    expect(formatExposureWeight("0.128")).toBe("13 %");
    expect(formatExposureWeight("0.005")).toBe("1 %");
  });

  test("a zero weight reads as 0 %, never blank", () => {
    expect(formatExposureWeight("0")).toBe("0 %");
  });
});

describe("geographyLabel", () => {
  test("maps a geography bucket key to its Spanish label", () => {
    expect(geographyLabel("us")).toBe("EE. UU.");
    expect(geographyLabel("emerging")).toBe("Emergentes");
    expect(geographyLabel("other")).toBe("Otros");
  });

  test("falls back to the raw key for an unknown bucket (never crashes)", () => {
    expect(geographyLabel("mars")).toBe("mars");
  });
});

describe("geographyForLens", () => {
  const full = dimension({ slices: [{ key: "us", value: eur(100), weight: "1" }] });
  const equity = dimension({
    slices: [{ key: "emerging", value: eur(40), weight: "1" }],
  });
  const lookthrough = { geography: full } as unknown as ExposureLookthrough;
  const equityLookthrough = { geography: equity } as unknown as ExposureLookthrough;

  test("returns the full-portfolio geography for the 'all' lens", () => {
    expect(geographyForLens("all", lookthrough, equityLookthrough)).toBe(full);
  });

  test("returns the equity-restricted geography for the 'equity' lens", () => {
    expect(geographyForLens("equity", lookthrough, equityLookthrough)).toBe(equity);
  });
});

describe("coverageParts", () => {
  test("orders classified, not-applicable, unknown with labels and values", () => {
    const parts = coverageParts({
      classified: eur(600),
      notApplicable: eur(300),
      unknown: eur(100),
    });

    expect(parts.map((part) => part.kind)).toEqual([
      "classified",
      "notApplicable",
      "unknown",
    ]);
    expect(parts.map((part) => part.value.amountMinor)).toEqual([600, 300, 100]);
    expect(parts[0]?.label).toBe("Clasificado");
    expect(parts[1]?.label).toBe("No aplica");
    expect(parts[2]?.label).toBe("Sin clasificar");
  });

  test("keeps a zero part so an absent unknown remainder is still shown as 0", () => {
    const parts = coverageParts({
      classified: eur(1000),
      notApplicable: eur(0),
      unknown: eur(0),
    });

    expect(parts).toHaveLength(3);
    expect(parts[2]?.value.amountMinor).toBe(0);
  });
});

describe("sectorLabel", () => {
  test("maps a GICS-11 sector key to its Spanish label", () => {
    expect(sectorLabel("information_technology")).toBe("Tecnología");
    expect(sectorLabel("consumer_staples")).toBe("Consumo básico");
    expect(sectorLabel("real_estate")).toBe("Inmobiliario");
  });

  test("falls back to the raw key for an unknown bucket (never crashes)", () => {
    expect(sectorLabel("crypto_mining")).toBe("crypto_mining");
  });
});

describe("sectorForLens", () => {
  const full = dimension({
    slices: [{ key: "information_technology", value: eur(100), weight: "1" }],
  });
  const equity = dimension({
    slices: [{ key: "health_care", value: eur(40), weight: "1" }],
  });
  const lookthrough = { sector: full } as unknown as ExposureLookthrough;
  const equityLookthrough = { sector: equity } as unknown as ExposureLookthrough;

  test("returns the full-portfolio sector for the 'all' lens", () => {
    expect(sectorForLens("all", lookthrough, equityLookthrough)).toBe(full);
  });

  test("returns the equity-restricted sector for the 'equity' lens", () => {
    expect(sectorForLens("equity", lookthrough, equityLookthrough)).toBe(equity);
  });
});

describe("sectorStyleForLens", () => {
  const fullStyle = { cyclical: "0.3", defensive: "0.5" };
  const equityStyle = { cyclical: "0.6", defensive: "0.4" };
  const lookthrough = { sectorStyle: fullStyle } as unknown as ExposureLookthrough;
  const equityLookthrough = {
    sectorStyle: equityStyle,
  } as unknown as ExposureLookthrough;

  test("picks the full-portfolio style for 'all' and the equity one for 'equity'", () => {
    expect(sectorStyleForLens("all", lookthrough, equityLookthrough)).toBe(fullStyle);
    expect(sectorStyleForLens("equity", lookthrough, equityLookthrough)).toBe(
      equityStyle,
    );
  });
});

describe("sectorStyleChips", () => {
  test("orders defensive then cyclical, each labelled with its weight", () => {
    const chips = sectorStyleChips({ cyclical: "0.3", defensive: "0.5" });
    expect(chips.map((chip) => chip.kind)).toEqual(["defensive", "cyclical"]);
    expect(chips[0]).toEqual({ kind: "defensive", label: "Defensivo", weight: "0.5" });
    expect(chips[1]).toEqual({ kind: "cyclical", label: "Cíclico", weight: "0.3" });
  });

  test("keeps a zero chip so an absent style side still reads as 0 %", () => {
    const chips = sectorStyleChips({ cyclical: "0", defensive: "0" });
    expect(chips).toHaveLength(2);
    expect(formatExposureWeight(chips[1]?.weight ?? "")).toBe("0 %");
  });
});

describe("assetClassLabel", () => {
  test("labels each bucket in Spanish, including the returns-only keys", () => {
    expect(assetClassLabel("equity")).toBe("Renta variable");
    expect(assetClassLabel("bond")).toBe("Renta fija");
    expect(assetClassLabel("other")).toBe("Otros");
    expect(assetClassLabel("unclassified")).toBe("Sin clasificar");
  });

  test("falls back to the raw key when unrecognised", () => {
    expect(assetClassLabel("weird")).toBe("weird");
  });
});
