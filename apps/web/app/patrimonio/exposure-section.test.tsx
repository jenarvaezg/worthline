import {
  createExposureProfile,
  lookThroughExposure,
  type ExposureLookthroughHolding,
  type ExposureProfile,
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
    createExposureProfile({
      breakdowns: { assetClass: { equity: "1" }, geography: { us: "1" } },
      key: "US-EQ",
    }),
  ],
  [
    "EU-BOND",
    createExposureProfile({
      breakdowns: {
        assetClass: { bond: "1" },
        geography: { europe_developed: "0.6", us: "0.4" },
      },
      key: "EU-BOND",
    }),
  ],
]);

const holdings: ExposureLookthroughHolding[] = [
  { currency: EUR, id: "a", instrument: "etf", isin: "US-EQ", valueMinor: 60_000 },
  { currency: EUR, id: "b", instrument: "fund", isin: "EU-BOND", valueMinor: 30_000 },
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

function render(initialLens: "all" | "equity"): string {
  return renderToStaticMarkup(
    <ExposureSection
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
