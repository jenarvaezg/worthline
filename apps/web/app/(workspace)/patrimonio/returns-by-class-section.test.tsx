import type { AssetClassReturnsViewResult } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import ReturnsByClassSection from "./returns-by-class-section";

/**
 * Render/wiring test for the /patrimonio per-asset-class returns section (#552).
 * It asserts each class row renders its Spanish label, value, and the three
 * measures (with an em dash for an un-computable one), that the two-way coverage
 * (clasificado / sin clasificar) is shown, and that the honest attribution caveat
 * is present, never buried.
 */

const EUR = "EUR";

function marketView(overrides: {
  totalReturnRatio: number | null;
  irrRate: number | null;
  twrRate: number | null;
}): AssetClassReturnsViewResult["classes"][number]["view"] {
  return {
    annualized: true,
    caveats: ["No incluye dividendos ni cupones."],
    cagr: 0.1,
    irr: {
      rate: overrides.irrRate,
      reason: overrides.irrRate === null ? "single_sign" : null,
    },
    kind: "market",
    realizedPnl: null,
    totalGain: { amountMinor: 30_000, currency: EUR },
    totalReturnRatio: overrides.totalReturnRatio,
    twr: {
      annualized: false,
      annualizedRate: null,
      endDate: "2026-01-01",
      rate: overrides.twrRate,
      reason: overrides.twrRate === null ? "insufficient_monthly_closes" : null,
      spanDays: 200,
      startDate: "2025-06-01",
    },
    unrealizedPnl: null,
  };
}

const result: AssetClassReturnsViewResult = {
  classes: [
    {
      key: "equity",
      value: { amountMinor: 150_000, currency: EUR },
      view: marketView({ irrRate: 0.082, totalReturnRatio: 0.5, twrRate: 0.071 }),
    },
    {
      key: "unclassified",
      value: { amountMinor: 40_000, currency: EUR },
      view: marketView({ irrRate: null, totalReturnRatio: 0.1, twrRate: null }),
    },
  ],
  coverage: {
    classified: { amountMinor: 150_000, currency: EUR },
    notApplicable: { amountMinor: 0, currency: EUR },
    unknown: { amountMinor: 40_000, currency: EUR },
  },
};

describe("ReturnsByClassSection", () => {
  test("renders each class's label, measures and the coverage + caveat", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode={false} returns={result} />,
    );

    expect(html).toContain("Renta variable");
    expect(html).toContain("Sin clasificar");
    // equity gain +50% and IRR/TWR present.
    expect(html).toContain("+50,0 %");
    expect(html).toContain("+8,2 %");
    expect(html).toContain("+7,1 %");
    // unclassified IRR/TWR are un-computable → em dash, never fabricated.
    expect(html).toContain("—");
    // Honest caveat surfaced.
    expect(html).toContain("no históricos");
  });

  test("masks money under privacy mode but still shows the percentages", () => {
    const html = renderToStaticMarkup(
      <ReturnsByClassSection privacyMode returns={result} />,
    );

    // 150_000 minor → "1.500 €" is masked to "*" digits; the percentages stay.
    expect(html).not.toContain("1.500");
    expect(html).toContain("+50,0 %");
  });
});
