import type { ValuationCadence } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { HousingValuationSection } from "./housing-valuation-section";

/**
 * The housing valuation surface carries an advanced valuation-cadence control
 * (ADR 0031, #394) beside the appreciation rate / appraisals. The surface itself
 * is only rendered for a housing (appreciating) asset, so the control is always
 * present here; the test asserts it shows and reflects the stored cadence.
 */
function renderFor(valuationCadence: ValuationCadence | null) {
  return renderToStaticMarkup(
    <HousingValuationSection
      anchors={[]}
      appreciationRate={null}
      assetId="a_home"
      formError={null}
      today="2026-06-14"
      valuationCadence={valuationCadence}
    />,
  );
}

describe("HousingValuationSection — valuation cadence advanced control (ADR 0031, #394)", () => {
  test("shows the cadence control with both options", () => {
    const markup = renderFor(null);
    expect(markup).toContain("Cadencia de valoración");
    expect(markup).toContain("Escalonado (por defecto)");
    expect(markup).toContain("Interpolado (suave a diario)");
  });

  test("reflects the stored cadence as the selected option (interpolated)", () => {
    const markup = renderFor("interpolated");
    expect(markup).toMatch(/value="interpolated"[^>]*selected/);
  });

  test("defaults to step when the stored cadence is null", () => {
    const markup = renderFor(null);
    expect(markup).toMatch(/value="step"[^>]*selected/);
  });
});
