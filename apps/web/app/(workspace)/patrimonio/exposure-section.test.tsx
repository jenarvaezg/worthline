import {
  type ExposureLookthroughHolding,
  type ExposureProfile,
  lookThroughExposure,
  type PortfolioCost,
  portfolioCost,
} from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import ExposureSection from "./exposure-section";

/**
 * Render/wiring test for the /patrimonio exposure section (PRD #539 S3, #543).
 * It asserts the section renders BOTH the full-portfolio geography and the
 * equity-restricted geography (each matching what `lookThroughExposure` returns,
 * so the section is a faithful view over the S0 aggregation), that coverage is
 * shown as the three-way split with the `unknown` remainder visible and
 * not-applicable labelled distinctly, and that the client lens toggle is wired
 * with both tabs deep-linkable and the active one marked (§8). The client island
 * SSRs its initial lens, so `initialLens` selects which pre-rendered breakdown
 * `renderToStaticMarkup` emits.
 */

const EUR = "EUR";

// A US equity fund (profile: 100% US geography, 100% equity class) + a bond fund
// (60% Europe / 40% US, bond class) + a raw crypto holding (not-applicable for
// geography). This gives a full-portfolio geography that MIXES the two funds and
// an equity-restricted one that is US-only, plus a non-zero not-applicable slice.
const profiles = new Map<string, ExposureProfile>([
  [
    "US-EQ",
    {
      key: "US-EQ",
      source: "user",
      declaredAt: null,
      hedged: false,
      breakdowns: {
        assetClass: { equity: "1" },
        geography: { us: "1" },
        // 60% cyclical (info tech) / 40% defensive (health care) of the equity sleeve.
        sector: { health_care: "0.4", information_technology: "0.6" },
      },
    },
  ],
  [
    "EU-BOND",
    {
      key: "EU-BOND",
      source: "user",
      declaredAt: null,
      hedged: false,
      breakdowns: {
        assetClass: { bond: "1" },
        geography: { europe_developed: "0.6", us: "0.4" },
      },
    },
  ],
]);

const holdings: ExposureLookthroughHolding[] = [
  {
    currency: EUR,
    id: "a",
    instrument: "etf",
    providerSymbol: "US-EQ",
    valueMinor: 60_000,
  },
  {
    currency: EUR,
    id: "b",
    instrument: "fund",
    providerSymbol: "EU-BOND",
    valueMinor: 30_000,
  },
  { currency: EUR, id: "c", instrument: "crypto", valueMinor: 10_000 },
];

const grossAssets = { amountMinor: 100_000, currency: EUR };
const full = lookThroughExposure({ baseCurrency: EUR, grossAssets, holdings, profiles });
const equity = lookThroughExposure({
  assetClassFilter: "equity",
  baseCurrency: EUR,
  grossAssets,
  holdings,
  profiles,
});

/** The portfolio-cost lens over the same rows and catalog (#1717). */
function costOf(
  rows: readonly ExposureLookthroughHolding[],
  catalog: ReadonlyMap<string, ExposureProfile>,
  gross = grossAssets,
): PortfolioCost {
  return portfolioCost({
    grossAssets: gross,
    holdings: rows.map((row) => ({
      id: row.id,
      instrument: row.instrument,
      providerSymbol: row.providerSymbol ?? null,
      securityId: null,
      value: { amountMinor: row.valueMinor, currency: EUR },
    })),
    profiles: catalog,
  });
}

const cost = costOf(holdings, profiles);

function render(initialLens: "all" | "equity"): string {
  return renderToStaticMarkup(
    <ExposureSection
      cost={cost}
      currentUrl="/patrimonio"
      equity={equity}
      full={full}
      initialLens={initialLens}
      privacyMode={false}
    />,
  );
}

describe("ExposureSection", () => {
  test("full-portfolio geography shows the mixed breakdown from lookThroughExposure", () => {
    // full: US = 60k (US-EQ) + 12k (40% of EU-BOND's 30k) = 72k; Europe = 18k.
    expect(full.geography.slices.map((s) => s.key)).toEqual(["us", "europe_developed"]);
    const html = render("all");
    expect(html).toContain("EE. UU.");
    expect(html).toContain("Europa desarrollada");
    // 72.000 minor → 720 € ; 18.000 minor → 180 €.
    expect(html).toContain("720");
    expect(html).toContain("180");
  });

  test("equity-restricted geography is US-only, matching lookThroughExposure", () => {
    // equity: only the US-EQ fund survives the equity filter → 100% US.
    expect(equity.geography.slices.map((s) => s.key)).toEqual(["us"]);
    const html = render("equity");
    expect(html).toContain("EE. UU.");
    // The equity view drops the bond fund, so no Europe slice.
    expect(html).not.toContain("Europa desarrollada");
  });

  test("coverage is the three-way split with not-applicable and unknown labelled", () => {
    // Geography coverage: 90k classified (both funds), 10k not-applicable (crypto).
    expect(full.geography.coverage.notApplicable.amountMinor).toBe(10_000);
    const html = render("all");
    expect(html).toContain("Clasificado");
    expect(html).toContain("No aplica");
    expect(html).toContain("Sin clasificar");
  });

  test("an all-unknown remainder is still rendered, never hidden", () => {
    // A lone stock with no profile is unknown for geography.
    const lone: ExposureLookthroughHolding[] = [
      { currency: EUR, id: "z", instrument: "stock", valueMinor: 100_000 },
    ];
    const unknownFull = lookThroughExposure({
      baseCurrency: EUR,
      grossAssets,
      holdings: lone,
      profiles: new Map(),
    });
    expect(unknownFull.geography.coverage.unknown.amountMinor).toBe(100_000);
    const html = renderToStaticMarkup(
      <ExposureSection
        cost={costOf(lone, new Map())}
        currentUrl="/patrimonio"
        equity={unknownFull}
        full={unknownFull}
        initialLens="all"
        privacyMode={false}
      />,
    );
    // The unknown coverage part carries the full 100k (1000 €) — visible, not
    // hidden. Assert against the formatter so the ICU-locale grouping (present or
    // not in this runtime) never makes the check brittle.
    expect(html).toContain("Sin clasificar");
    const unknownPart = html.slice(html.indexOf("Sin clasificar"));
    expect(unknownPart).toMatch(/1[.\s]?000/);
  });

  test("wires the lens toggle: both deep-linkable tabs, the active one marked", () => {
    const html = render("all");
    expect(html).toContain("Cartera completa");
    expect(html).toContain("Solo renta variable");
    // The equity tab deep-links via ?exp=equity; the default 'all' stays clean.
    expect(html).toContain('href="/patrimonio?exp=equity"');
    expect(html).toContain('href="/patrimonio"');
    // The active 'all' lens is marked current (§8).
    expect(html).toMatch(/aria-current="true"[^>]*>Cartera completa/);
  });

  test("full-portfolio sector block shows the equity-scaled GICS breakdown", () => {
    // US-EQ (60k, 100% equity) carries 60% info tech / 40% health care; the bond
    // and crypto contribute no equity sleeve → sector classified = 60k.
    expect(full.sector.slices.map((s) => s.key)).toEqual([
      "information_technology",
      "health_care",
    ]);
    expect(full.sector.coverage.classified.amountMinor).toBe(60_000);
    expect(full.sector.coverage.notApplicable.amountMinor).toBe(40_000);
    const html = render("all");
    expect(html).toContain("Por sector · de la renta variable");
    expect(html).toContain("Tecnología");
    expect(html).toContain("Salud");
    // 36.000 minor → 360 € (info tech) ; 24.000 minor → 240 € (health care).
    expect(html).toContain("360");
    expect(html).toContain("240");
  });

  test("defensive/cyclical chips render as a derived lens over the sector bars", () => {
    // full sector-style over gross: defensive (health) 24k → 24 %, cyclical
    // (info tech) 36k → 36 %; the uncovered remainder stays out of the chips.
    expect(full.sectorStyle).toEqual({ cyclical: "0.36", defensive: "0.24" });
    const html = render("all");
    expect(html).toContain("Defensivo");
    expect(html).toContain("Cíclico");
    expect(html).toContain("24 %");
    expect(html).toContain("36 %");
  });

  test("the lens toggle re-scales the sector block to the equity sleeve", () => {
    // Equity lens drops the bond → sector base is the 60k equity sleeve, so the
    // same vector reads 60 % / 40 % and the defensive chip climbs to 40 %.
    expect(equity.sector.slices.map((s) => s.weight)).toEqual(["0.6", "0.4"]);
    expect(equity.sectorStyle).toEqual({ cyclical: "0.6", defensive: "0.4" });
    const html = render("equity");
    expect(html).toContain("Por sector · de la renta variable");
    expect(html).toContain("Tecnología");
    expect(html).toContain("40 %");
    expect(html).toContain("60 %");
  });

  test("currency-risk readout renders per-currency unhedged share", () => {
    // A USD-priced holding with no profile is unhedged non-EUR → currency risk.
    const usd: ExposureLookthroughHolding[] = [
      { currency: "USD", id: "u", instrument: "stock", valueMinor: 50_000 },
    ];
    const usdFull = lookThroughExposure({
      baseCurrency: EUR,
      grossAssets: { amountMinor: 50_000, currency: EUR },
      holdings: usd,
      profiles: new Map(),
    });
    expect(usdFull.currencyRisk.map((s) => s.key)).toEqual(["USD"]);
    const html = renderToStaticMarkup(
      <ExposureSection
        cost={costOf(usd, new Map(), { amountMinor: 50_000, currency: EUR })}
        currentUrl="/patrimonio"
        equity={usdFull}
        full={usdFull}
        initialLens="all"
        privacyMode={false}
      />,
    );
    expect(html).toContain("Riesgo divisa no cubierto");
    expect(html).toContain("USD");
  });
});

describe("ExposureSection — coste de la cartera (#1717)", () => {
  // 60.000 € of a world ETF at 0,20 % and 30.000 € of a bond fund at 0,10 %
  // declare a TER; 10.000 € of another fund declares none. 120 € + 30 € = 150 €
  // a year, a mean of 150 € / 90.000 € = 0,1667 % over 90 % of gross.
  const costHoldings: ExposureLookthroughHolding[] = [
    {
      currency: EUR,
      id: "w",
      instrument: "etf",
      providerSymbol: "WORLD",
      valueMinor: 60_000_00,
    },
    {
      currency: EUR,
      id: "b",
      instrument: "fund",
      providerSymbol: "BONDS",
      valueMinor: 30_000_00,
    },
    {
      currency: EUR,
      id: "x",
      instrument: "fund",
      providerSymbol: "BLANK",
      valueMinor: 10_000_00,
    },
  ];
  const terProfile = (key: string, ter: string): [string, ExposureProfile] => [
    key,
    { breakdowns: {}, declaredAt: null, key, source: "user", ter },
  ];
  const costProfiles = new Map<string, ExposureProfile>([
    terProfile("WORLD", "0.002"),
    terProfile("BONDS", "0.001"),
  ]);
  const costGross = { amountMinor: 100_000_00, currency: EUR };
  const priced = costOf(costHoldings, costProfiles, costGross);
  const costLook = lookThroughExposure({
    baseCurrency: EUR,
    grossAssets: costGross,
    holdings: costHoldings,
    profiles: costProfiles,
  });

  function renderCost(sectionCost: PortfolioCost, privacyMode = false): string {
    return renderToStaticMarkup(
      <ExposureSection
        cost={sectionCost}
        currentUrl="/patrimonio"
        equity={costLook}
        full={costLook}
        initialLens="all"
        privacyMode={privacyMode}
      />,
    );
  }

  test("reads the yearly cost, the mean TER and the share of gross it rests on", () => {
    expect(priced.annualCost.amountMinor).toBe(150_00);
    const html = renderCost(priced);
    expect(html).toContain("Coste de la cartera");
    expect(html).toMatch(/Tu cartera cuesta <b>~150[\s\u00a0]€\/año<\/b>/);
    expect(html).toContain("TER medio 0,17 %");
    expect(html).toContain("sobre el 90 % del bruto con dato");
  });

  test("shows the three-way TER coverage with the undeclared remainder visible", () => {
    const html = renderCost(priced);
    const block = html.slice(html.indexOf("Coste de la cartera"));
    expect(block).toContain("Con TER");
    expect(block).toContain("No aplica");
    expect(block).toContain("Sin declarar");
    // The 10.000 € fund with no TER is the gap, shown — never folded into 0.
    expect(block.slice(block.indexOf("Sin declarar"))).toMatch(/10[.\s]?000/);
  });

  test("says the TER is already inside the NAV, so returns never subtract it", () => {
    expect(renderCost(priced)).toContain("no se resta otra vez de la rentabilidad");
  });

  test("privacy mode masks the euros but keeps the percentages", () => {
    const html = renderCost(priced, true);
    expect(html).not.toMatch(/~150/);
    expect(html).toContain("TER medio 0,17 %");
  });

  test("with no TER declared it names the gap instead of pricing the portfolio at 0", () => {
    const html = renderCost(costOf(costHoldings, new Map(), costGross));
    expect(html).toContain("Coste de la cartera");
    expect(html).not.toContain("Tu cartera cuesta");
    expect(html).toContain("Ningún fondo de la cartera tiene TER declarado");
  });
});
