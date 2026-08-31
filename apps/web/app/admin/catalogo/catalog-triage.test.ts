import type { GlobalExposureProfile } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import {
  asOfAgeMonths,
  asOfIsStale,
  asOfText,
  catalogSearchString,
  confidenceIsWeak,
  confidenceLabel,
  countNeedsCategorizing,
  countStaleAsOf,
  countWeakConfidence,
  dimensionDeclared,
  dimensionRemainder,
  identityText,
  parseCatalogParams,
  profileCoverage,
  profileKey,
  profileNeedsCategorizing,
  STALE_AS_OF_MONTHS,
  visibleProfiles,
} from "./catalog-triage";

/** The day the triage register is read — a parameter, never the clock. */
const TODAY = "2026-08-31";

function profile(overrides: Partial<GlobalExposureProfile>): GlobalExposureProfile {
  return {
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: null,
    breakdowns: {},
    ter: null,
    trackedIndex: null,
    hedgedToCurrency: null,
    confidence: null,
    asOfDate: null,
    sources: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("dimension coverage", () => {
  it("sums declared weights and clamps to [0,1]", () => {
    expect(dimensionDeclared({ us: "0.6", emerging: "0.3" })).toBeCloseTo(0.9);
    expect(dimensionDeclared(undefined)).toBe(0);
    expect(dimensionDeclared({ us: "1", europe_developed: "0.5" })).toBe(1);
  });

  it("reports the undeclared remainder", () => {
    expect(dimensionRemainder({ us: "0.6" })).toBeCloseTo(0.4);
    expect(dimensionRemainder(undefined)).toBe(1);
    expect(dimensionRemainder({ us: "1" })).toBe(0);
  });

  it("ignores non-numeric weights rather than throwing", () => {
    expect(dimensionDeclared({ us: "not-a-number", emerging: "0.2" })).toBeCloseTo(0.2);
  });
});

describe("profileNeedsCategorizing", () => {
  it("is true when any dimension is under-declared (including absent ones)", () => {
    expect(profileNeedsCategorizing(profile({ breakdowns: {} }))).toBe(true);
    expect(
      profileNeedsCategorizing(profile({ breakdowns: { geography: { us: "0.5" } } })),
    ).toBe(true);
  });

  it("is false only when all three dimensions are fully declared", () => {
    const fully = profile({
      breakdowns: {
        geography: { us: "1" },
        currency: { USD: "1" },
        assetClass: { equity: "1" },
      },
    });
    expect(profileNeedsCategorizing(fully)).toBe(false);
  });

  it("does not ask for geography or currency when the profile is 100% commodity", () => {
    expect(
      profileNeedsCategorizing(
        profile({ breakdowns: { assetClass: { commodity: "1" } } }),
      ),
    ).toBe(false);
  });

  it("does not ask for geography or currency when the profile is 100% crypto", () => {
    expect(
      profileNeedsCategorizing(profile({ breakdowns: { assetClass: { crypto: "1" } } })),
    ).toBe(false);
  });

  it("still needs categorizing when commodity is mixed with equity", () => {
    expect(
      profileNeedsCategorizing(
        profile({ breakdowns: { assetClass: { commodity: "0.3", equity: "0.7" } } }),
      ),
    ).toBe(true);
  });

  it("counts sin_region toward declared geography so a mixed gold fund can leave the filter", () => {
    expect(
      profileNeedsCategorizing(
        profile({
          breakdowns: {
            geography: { europe_developed: "0.74", sin_region: "0.26" },
            currency: { EUR: "0.74", sin_divisa: "0.26" },
            assetClass: { commodity: "0.25", equity: "0.75" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("still flags a geography remainder when sin_region does not fill the gap", () => {
    expect(
      profileNeedsCategorizing(
        profile({
          breakdowns: {
            geography: { europe_developed: "0.74", sin_region: "0.25" },
            currency: { EUR: "1" },
            assetClass: { equity: "1" },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("profileCoverage", () => {
  it("averages declared fractions across the three dimensions", () => {
    const p = profile({
      breakdowns: {
        geography: { us: "1" },
        currency: { USD: "0.5" },
        // assetClass absent → 0
      },
    });
    expect(profileCoverage(p)).toBeCloseTo((1 + 0.5 + 0) / 3);
  });
});

describe("countNeedsCategorizing", () => {
  it("counts over the full set regardless of any filter", () => {
    const profiles = [
      profile({ identity: { kind: "isin", isin: "IE00B4L5Y983" } }),
      profile({
        identity: { kind: "provider", priceProvider: "yahoo", providerSymbol: "VOO" },
        breakdowns: {
          geography: { us: "1" },
          currency: { USD: "1" },
          assetClass: { equity: "1" },
        },
      }),
    ];
    expect(countNeedsCategorizing(profiles)).toBe(1);
  });
});

describe("identityText / profileKey", () => {
  it("renders ISIN identities and provider·symbol identities", () => {
    expect(identityText({ kind: "isin", isin: "IE00B4L5Y983" })).toBe("IE00B4L5Y983");
    expect(
      identityText({ kind: "provider", priceProvider: "yahoo", providerSymbol: "VOO" }),
    ).toBe("yahoo · VOO");
  });

  it("keys provider identities distinctly from ISINs", () => {
    expect(
      profileKey(
        profile({
          identity: { kind: "provider", priceProvider: "yahoo", providerSymbol: "VOO" },
        }),
      ),
    ).toBe("p:yahoo:VOO");
  });
});

describe("visibleProfiles", () => {
  const uncovered = profile({
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: "Vanguard World",
    breakdowns: { geography: { us: "0.2" } },
  });
  const halfCovered = profile({
    identity: { kind: "provider", priceProvider: "yahoo", providerSymbol: "VOO" },
    displayName: "S&P 500",
    breakdowns: {
      geography: { us: "1" },
      currency: { USD: "0.5" },
    },
  });
  const fullyCovered = profile({
    identity: { kind: "isin", isin: "US9229087690" },
    displayName: "Total Market",
    breakdowns: {
      geography: { us: "1" },
      currency: { USD: "1" },
      assetClass: { equity: "1" },
    },
  });
  const all = [halfCovered, fullyCovered, uncovered];

  it("in 'todos' shows every profile sorted by identity text", () => {
    const result = visibleProfiles(all, { filter: "todos", query: "" }, TODAY);
    expect(result.map((p) => identityText(p.identity))).toEqual([
      "IE00B4L5Y983",
      "US9229087690",
      "yahoo · VOO",
    ]);
  });

  it("in 'por-categorizar' keeps only under-declared, least-covered first", () => {
    const result = visibleProfiles(all, { filter: "por-categorizar", query: "" }, TODAY);
    expect(result).toEqual([uncovered, halfCovered]);
    expect(result).not.toContain(fullyCovered);
  });

  it("filters by search across identity and display name, case-insensitive", () => {
    expect(
      visibleProfiles(all, { filter: "todos", query: "s&p" }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["S&P 500"]);
    expect(
      visibleProfiles(all, { filter: "todos", query: "US922" }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Total Market"]);
  });
});

describe("URL round-trip", () => {
  it("serializes only non-default view state", () => {
    expect(catalogSearchString({ filter: "todos", query: "", selectedKey: null })).toBe(
      "",
    );
    expect(
      catalogSearchString({
        filter: "por-categorizar",
        query: "voo",
        selectedKey: "p:yahoo:VOO",
      }),
    ).toBe("?filtro=por-categorizar&q=voo&perfil=p%3Ayahoo%3AVOO");
  });

  it("parses params back with defaults", () => {
    expect(parseCatalogParams({})).toEqual({
      filter: "todos",
      query: "",
      selectedKey: null,
    });
    expect(
      parseCatalogParams({ filtro: "por-categorizar", q: "voo", perfil: "p:yahoo:VOO" }),
    ).toEqual({ filter: "por-categorizar", query: "voo", selectedKey: "p:yahoo:VOO" });
  });

  it("round-trips the provenance filters and ignores an unknown one (#1508)", () => {
    for (const filter of ["confianza-baja", "corte-antiguo"] as const) {
      expect(catalogSearchString({ filter, query: "", selectedKey: null })).toBe(
        `?filtro=${filter}`,
      );
      expect(parseCatalogParams({ filtro: filter }).filter).toBe(filter);
    }
    expect(parseCatalogParams({ filtro: "confianza-altísima" }).filter).toBe("todos");
  });
});

describe("provenance triage (#1508)", () => {
  const verified = profile({
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: "Pacific ex Japan",
    confidence: "alta",
    asOfDate: "2026-07-31",
    sources: "factsheet MSCI 31/07/2026",
  });
  const mandate = profile({
    identity: { kind: "isin", isin: "US9229087690" },
    displayName: "Palm Harbour Global Value",
    confidence: "baja",
    asOfDate: "2026-08-01",
    sources: "ficha de la gestora",
  });
  const rotten = profile({
    identity: { kind: "provider", priceProvider: "finect", providerSymbol: "N5394" },
    displayName: "MyInvestor Indexado Global, PP",
    confidence: "media",
    asOfDate: "2024-04-30",
    sources: "ficha mensual del plan",
  });
  const undeclared = profile({
    identity: { kind: "provider", priceProvider: "yahoo", providerSymbol: "VOO" },
    displayName: "S&P 500",
  });
  const all = [verified, mandate, rotten, undeclared];

  it("reads an undeclared confidence as «sin declarar», never as a level", () => {
    expect(confidenceLabel(undeclared.confidence)).toBe("sin declarar");
    expect(confidenceLabel(mandate.confidence)).toBe("baja");
    expect(confidenceIsWeak(undeclared)).toBe(true);
    expect(confidenceIsWeak(mandate)).toBe(true);
    expect(confidenceIsWeak(rotten)).toBe(false);
    expect(confidenceIsWeak(verified)).toBe(false);
  });

  it("measures the cut-off age in calendar months", () => {
    expect(asOfAgeMonths("2026-07-31", TODAY)).toBe(1);
    expect(asOfAgeMonths("2024-04-30", TODAY)).toBe(28);
    expect(asOfAgeMonths("2026-08-31", TODAY)).toBe(0);
    expect(asOfAgeMonths("2026-09-30", TODAY)).toBe(-1);
  });

  it("counts a cut-off as stale past a year, and an absent one always", () => {
    expect(asOfIsStale(verified, TODAY)).toBe(false);
    expect(asOfIsStale(rotten, TODAY)).toBe(true);
    expect(asOfIsStale(undeclared, TODAY)).toBe(true);
    expect(
      asOfIsStale(profile({ asOfDate: "2025-08-31" }), TODAY),
      `exactly ${STALE_AS_OF_MONTHS} months old is already stale`,
    ).toBe(true);
    expect(asOfIsStale(profile({ asOfDate: "2025-09-30" }), TODAY)).toBe(false);
  });

  it("shows the cut-off day as the app reads it out loud", () => {
    expect(asOfText(rotten)).toBe("30/04/2024");
    expect(asOfText(undeclared)).toBe("sin declarar");
  });

  it("in 'confianza-baja' keeps only weak provenance, «baja» ahead of undeclared", () => {
    expect(
      visibleProfiles(all, { filter: "confianza-baja", query: "" }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Palm Harbour Global Value", "S&P 500"]);
  });

  it("in 'corte-antiguo' keeps only stale cut-offs, undeclared first then oldest", () => {
    expect(
      visibleProfiles(all, { filter: "corte-antiguo", query: "" }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["S&P 500", "MyInvestor Indexado Global, PP"]);
  });

  it("the provenance filters still honour the search box", () => {
    expect(
      visibleProfiles(all, { filter: "corte-antiguo", query: "myinvestor" }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["MyInvestor Indexado Global, PP"]);
  });

  it("counts weak confidence and stale cut-offs over the full set", () => {
    expect(countWeakConfidence(all)).toBe(2);
    expect(countStaleAsOf(all, TODAY)).toBe(2);
    expect(countWeakConfidence([verified])).toBe(0);
    expect(countStaleAsOf([verified], TODAY)).toBe(0);
  });
});
