import type { FxExcludedHolding } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HeroFxPartial from "./hero-fx-partial";

function render(excluded: FxExcludedHolding[]): string {
  return renderToStaticMarkup(<HeroFxPartial excluded={excluded} />);
}

const usdHolding: FxExcludedHolding = {
  holdingId: "asset_usd",
  name: "Cuenta USD",
  original: { amountMinor: 100_000, currency: "USD" },
  reason: "missing-rate",
};

describe("HeroFxPartial (#1065)", () => {
  it("renders nothing for an all-EUR portfolio (no exclusions)", () => {
    expect(render([])).toBe("");
  });

  it("names the excluded holding and states it is not counted, in singular", () => {
    const html = render([usdHolding]);
    expect(html).toContain('role="status"');
    expect(html).toContain("No incluido");
    expect(html).toContain("1 holding");
    expect(html).toContain("Cuenta USD");
    expect(html).toContain("el total no lo incluye");
  });

  it("pluralizes and lists every excluded holding", () => {
    const html = render([
      usdHolding,
      {
        holdingId: "asset_gbp",
        name: "ISA UK",
        original: { amountMinor: 50_000, currency: "GBP" },
        reason: "missing-rate",
      },
    ]);
    expect(html).toContain("2 holdings");
    expect(html).toContain("Cuenta USD");
    expect(html).toContain("ISA UK");
    expect(html).toContain("el total no los incluye");
  });
});
