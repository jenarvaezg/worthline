import type { GlobalExposureProfile } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import {
  catalogSearchString,
  countNeedsCategorizing,
  dimensionDeclared,
  dimensionRemainder,
  identityText,
  parseCatalogParams,
  profileCoverage,
  profileKey,
  profileNeedsCategorizing,
  visibleProfiles,
} from "./catalog-triage";

function profile(overrides: Partial<GlobalExposureProfile>): GlobalExposureProfile {
  return {
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: null,
    breakdowns: {},
    ter: null,
    trackedIndex: null,
    hedgedToCurrency: null,
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
    const result = visibleProfiles(all, { filter: "todos", query: "" });
    expect(result.map((p) => identityText(p.identity))).toEqual([
      "IE00B4L5Y983",
      "US9229087690",
      "yahoo · VOO",
    ]);
  });

  it("in 'por-categorizar' keeps only under-declared, least-covered first", () => {
    const result = visibleProfiles(all, { filter: "por-categorizar", query: "" });
    expect(result).toEqual([uncovered, halfCovered]);
    expect(result).not.toContain(fullyCovered);
  });

  it("filters by search across identity and display name, case-insensitive", () => {
    expect(
      visibleProfiles(all, { filter: "todos", query: "s&p" }).map((p) => p.displayName),
    ).toEqual(["S&P 500"]);
    expect(
      visibleProfiles(all, { filter: "todos", query: "US922" }).map((p) => p.displayName),
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
});
