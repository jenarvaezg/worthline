import type { GlobalExposureProfile } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import {
  asOfAgeMonths,
  asOfIsStale,
  asOfSortKey,
  asOfText,
  CATALOG_FILTER_OPTIONS,
  CATALOG_LENSES,
  catalogSearchString,
  confidenceIsWeak,
  confidenceText,
  countMatching,
  dimensionDeclared,
  dimensionRemainder,
  identityText,
  MATERIAL_GAP_THRESHOLD,
  parseCatalogParams,
  profileCoverage,
  profileKey,
  profileNeedsCategorizing,
  profileWorstGap,
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
            // El ejemplo era 0,74 + 0,25 = 0,99, un hueco de EXACTAMENTE el 1%,
            // que desde #1678 queda por debajo del umbral de materialidad. La
            // intención del test no cambia —si `sin_region` no cierra el hueco,
            // sigue marcando—, así que el hueco se hace material en vez de
            // relajar la aserción; la frontera se pincha en su propio bloque.
            geography: { europe_developed: "0.74", sin_region: "0.2" },
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

describe("countMatching", () => {
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
    expect(countMatching(profiles, "por-categorizar", TODAY)).toBe(1);
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
    const result = visibleProfiles(
      all,
      { filter: "todos", query: "", sort: null },
      TODAY,
    );
    expect(result.map((p) => identityText(p.identity))).toEqual([
      "IE00B4L5Y983",
      "US9229087690",
      "yahoo · VOO",
    ]);
  });

  it("in 'por-categorizar' keeps only under-declared, least-covered first", () => {
    const result = visibleProfiles(
      all,
      { filter: "por-categorizar", query: "", sort: null },
      TODAY,
    );
    expect(result).toEqual([uncovered, halfCovered]);
    expect(result).not.toContain(fullyCovered);
  });

  it("filters by search across identity and display name, case-insensitive", () => {
    expect(
      visibleProfiles(all, { filter: "todos", query: "s&p", sort: null }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["S&P 500"]);
    expect(
      visibleProfiles(all, { filter: "todos", query: "US922", sort: null }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Total Market"]);
  });
});

describe("URL round-trip", () => {
  it("serializes only non-default view state", () => {
    expect(
      catalogSearchString({ filter: "todos", query: "", sort: null, selectedKey: null }),
    ).toBe("");
    expect(
      catalogSearchString({
        filter: "por-categorizar",
        query: "voo",
        sort: null,
        selectedKey: "p:yahoo:VOO",
      }),
    ).toBe("?filtro=por-categorizar&q=voo&perfil=p%3Ayahoo%3AVOO");
  });

  it("parses params back with defaults", () => {
    expect(parseCatalogParams({})).toEqual({
      filter: "todos",
      query: "",
      sort: null,
      selectedKey: null,
    });
    expect(
      parseCatalogParams({ filtro: "por-categorizar", q: "voo", perfil: "p:yahoo:VOO" }),
    ).toEqual({
      filter: "por-categorizar",
      query: "voo",
      sort: null,
      selectedKey: "p:yahoo:VOO",
    });
  });

  it("round-trips the provenance filters and ignores an unknown one (#1508)", () => {
    for (const filter of ["confianza-baja", "corte-antiguo"] as const) {
      expect(
        catalogSearchString({ filter, query: "", sort: null, selectedKey: null }),
      ).toBe(`?filtro=${filter}`);
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
    expect(confidenceText(undeclared)).toBe("sin declarar");
    expect(confidenceText(mandate)).toBe("baja");
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

  it("treats an unreadable cut-off as stale, never as fresh (untyped TEXT column)", () => {
    // The column is plain TEXT written by an out-of-repo pass. A day that does
    // not exist, or something that is not a date at all, must land in the lens
    // that asks a human to look — not silently read as zero months old.
    for (const asOfDate of ["2024-02-30", "abril de 2024", ""]) {
      const corrupt = profile({ asOfDate });
      expect(asOfSortKey(corrupt), `sort key for "${asOfDate}"`).toBeNull();
      expect(asOfIsStale(corrupt, TODAY), `staleness of "${asOfDate}"`).toBe(true);
    }
    // …and it is never prettified into a date it is not.
    expect(asOfText(profile({ asOfDate: "abril de 2024" }))).toBe("abril de 2024");
  });

  it("in 'confianza-baja' keeps only weak provenance, «baja» ahead of undeclared", () => {
    expect(
      visibleProfiles(
        all,
        { filter: "confianza-baja", query: "", sort: null },
        TODAY,
      ).map((p) => p.displayName),
    ).toEqual(["Palm Harbour Global Value", "S&P 500"]);
  });

  it("in 'corte-antiguo' keeps only stale cut-offs, undeclared first then oldest", () => {
    expect(
      visibleProfiles(all, { filter: "corte-antiguo", query: "", sort: null }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["S&P 500", "MyInvestor Indexado Global, PP"]);
  });

  it("the provenance filters still honour the search box", () => {
    expect(
      visibleProfiles(
        all,
        { filter: "corte-antiguo", query: "myinvestor", sort: null },
        TODAY,
      ).map((p) => p.displayName),
    ).toEqual(["MyInvestor Indexado Global, PP"]);
  });

  it("counts weak confidence and stale cut-offs over the full set", () => {
    expect(countMatching(all, "confianza-baja", TODAY)).toBe(2);
    expect(countMatching(all, "corte-antiguo", TODAY)).toBe(2);
    expect(countMatching(all, "todos", TODAY)).toBe(4);
    expect(countMatching([verified], "confianza-baja", TODAY)).toBe(0);
    expect(countMatching([verified], "corte-antiguo", TODAY)).toBe(0);
  });

  it("says «o sin declarar» wherever a lens folds the undeclared rows in", () => {
    // The counter must not assert «de confianza baja» about a row that merely
    // lacks a declaration — the lens groups them, the wording keeps them apart.
    expect(CATALOG_LENSES["confianza-baja"].countLabel(2)).toBe(
      "2 de confianza baja o sin declarar",
    );
    expect(CATALOG_LENSES["corte-antiguo"].countLabel(2)).toBe(
      `2 con corte de más de ${STALE_AS_OF_MONTHS} meses o sin fecha`,
    );
    expect(CATALOG_FILTER_OPTIONS.map((option) => option.label)).toEqual([
      "Todos",
      "Por categorizar",
      "Baja o sin declarar",
      "Corte antiguo o sin fecha",
    ]);
  });
});

describe("ordering is separable from filtering (#1508)", () => {
  const verified = profile({
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: "Pacific ex Japan",
    confidence: "alta",
    asOfDate: "2026-07-31",
  });
  const mandate = profile({
    identity: { kind: "isin", isin: "US9229087690" },
    displayName: "Palm Harbour",
    confidence: "baja",
    asOfDate: "2026-08-01",
  });
  const rotten = profile({
    identity: { kind: "provider", priceProvider: "finect", providerSymbol: "N5394" },
    displayName: "MyInvestor PP",
    confidence: "media",
    asOfDate: "2024-04-30",
  });
  const all = [verified, mandate, rotten];

  it("orders the WHOLE set by confidence without dropping a row", () => {
    expect(
      visibleProfiles(all, { filter: "todos", query: "", sort: "confianza" }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Palm Harbour", "MyInvestor PP", "Pacific ex Japan"]);
  });

  it("orders the WHOLE set by cut-off antiquity without dropping a row", () => {
    expect(
      visibleProfiles(all, { filter: "todos", query: "", sort: "corte" }, TODAY).map(
        (p) => p.displayName,
      ),
    ).toEqual(["MyInvestor PP", "Pacific ex Japan", "Palm Harbour"]);
  });

  it("an explicit order wins inside a lens too, keeping the lens's rows", () => {
    const rows = visibleProfiles(
      all,
      { filter: "confianza-baja", query: "", sort: "identidad" },
      TODAY,
    );
    expect(rows.map((p) => p.displayName)).toEqual(["Palm Harbour"]);
  });

  it("with no explicit order each lens reads in its own worst-first order", () => {
    expect(CATALOG_LENSES.todos.defaultSort).toBe("identidad");
    expect(CATALOG_LENSES["por-categorizar"].defaultSort).toBe("cobertura");
    expect(CATALOG_LENSES["confianza-baja"].defaultSort).toBe("confianza");
    expect(CATALOG_LENSES["corte-antiguo"].defaultSort).toBe("corte");
  });

  it("round-trips the order in the URL and ignores an unknown one", () => {
    expect(
      catalogSearchString({
        filter: "todos",
        query: "",
        sort: "corte",
        selectedKey: null,
      }),
    ).toBe("?orden=corte");
    expect(parseCatalogParams({ orden: "confianza" }).sort).toBe("confianza");
    expect(parseCatalogParams({ orden: "por-lo-que-sea" }).sort).toBeNull();
  });
});

describe("materiality threshold (#1678)", () => {
  it("does not flag a gap below the threshold, and does flag one above", () => {
    const casi = profile({
      breakdowns: {
        geography: { us: "1" },
        currency: { USD: "0.997" },
        assetClass: { equity: "1" },
      },
    });
    expect(
      profileNeedsCategorizing(casi),
      "three tenths of a percent is not a work item",
    ).toBe(false);

    const material = profile({
      breakdowns: {
        geography: { us: "1" },
        currency: { USD: "0.98" },
        assetClass: { equity: "1" },
      },
    });
    expect(profileNeedsCategorizing(material)).toBe(true);
  });

  it("puts the boundary exactly at the threshold: 1% is not material, 1.01% is", () => {
    const complete = { geography: { us: "1" }, assetClass: { equity: "1" } };
    expect(
      profileNeedsCategorizing(
        profile({ breakdowns: { ...complete, currency: { USD: "0.99" } } }),
      ),
      `a gap of exactly ${MATERIAL_GAP_THRESHOLD} is not over the threshold`,
    ).toBe(false);
    expect(
      profileNeedsCategorizing(
        profile({ breakdowns: { ...complete, currency: { USD: "0.9899" } } }),
      ),
    ).toBe(true);
  });

  it("still flags a dimension that was never declared at all", () => {
    // An absent axis is 100% missing, so the threshold never rescues it.
    expect(profileNeedsCategorizing(profile({ breakdowns: {} }))).toBe(true);
  });

  it("keeps the float epsilon out of it: 0.9999999 was never a gap", () => {
    expect(
      profileNeedsCategorizing(
        profile({
          breakdowns: {
            geography: { us: "0.9999999" },
            currency: { USD: "1" },
            assetClass: { equity: "1" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("the «por categorizar» lens honours the threshold", () => {
    const trivial = profile({
      identity: { kind: "isin", isin: "IE00B4L5Y983" },
      displayName: "tres décimas",
      breakdowns: {
        geography: { us: "1" },
        currency: { USD: "0.997" },
        assetClass: { equity: "1" },
      },
    });
    const grave = profile({
      identity: { kind: "isin", isin: "US9229087690" },
      displayName: "treinta puntos",
      breakdowns: {
        geography: { us: "0.7" },
        currency: { USD: "1" },
        assetClass: { equity: "1" },
      },
    });
    expect(
      visibleProfiles(
        [trivial, grave],
        { filter: "por-categorizar", query: "", sort: null },
        TODAY,
      ).map((p) => p.displayName),
    ).toEqual(["treinta puntos"]);
    expect(countMatching([trivial, grave], "por-categorizar", TODAY)).toBe(1);
  });
});

describe("profileWorstGap (#1678)", () => {
  it("reports the largest gap and which dimension carries it", () => {
    expect(
      profileWorstGap(
        profile({
          breakdowns: {
            geography: { us: "0.9" },
            currency: { USD: "0.7" },
            assetClass: { equity: "1" },
          },
        }),
      ),
    ).toEqual({ dimension: "currency", remainder: expect.closeTo(0.3, 6) });
  });

  it("reports a SUB-threshold gap too — it is true, just not worth chasing", () => {
    const gap = profileWorstGap(
      profile({
        breakdowns: {
          geography: { us: "1" },
          currency: { USD: "0.997" },
          assetClass: { equity: "1" },
        },
      }),
    );
    expect(gap?.dimension).toBe("currency");
    expect(gap?.remainder).toBeCloseTo(0.003, 6);
  });

  it("is null when the three dimensions are complete", () => {
    expect(
      profileWorstGap(
        profile({
          breakdowns: {
            geography: { us: "1" },
            currency: { USD: "1" },
            assetClass: { equity: "1" },
          },
        }),
      ),
    ).toBeNull();
  });

  it("ignores geography and currency for a commodity vector, like the filter does", () => {
    // #1452: metal has no country and no underlying currency, so those axes are
    // not applicable — the gap must not be reported against them.
    expect(
      profileWorstGap(profile({ breakdowns: { assetClass: { commodity: "1" } } })),
    ).toBeNull();
  });
});
