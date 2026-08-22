import type { ValuationAnchorRecord } from "@worthline/db";
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
function renderFor(
  valuationCadence: ValuationCadence | null,
  anchors: ValuationAnchorRecord[] = [],
) {
  return renderToStaticMarkup(
    <HousingValuationSection
      anchors={anchors}
      appreciationRate={null}
      assetId="a_home"
      currentUrl="/patrimonio/wl_hld_a_home/editar"
      formError={null}
      today="2026-06-14"
      valuationCadence={valuationCadence}
    />,
  );
}

const acquisitionAnchor: ValuationAnchorRecord = {
  adjustsPriorCurve: true,
  assetId: "a_home",
  id: "anchor_acquisition",
  kind: "acquisition",
  source: "manual",
  valuationDate: "2004-05-19",
  valueMinor: 15_025_303,
};

const appraisalAnchor: ValuationAnchorRecord = {
  adjustsPriorCurve: true,
  assetId: "a_home",
  id: "anchor_tasacion",
  kind: null,
  source: "manual",
  valuationDate: "2026-07-09",
  valueMinor: 23_300_000,
};

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

describe("HousingValuationSection — adquisición por su nombre (#1437)", () => {
  test("names the acquisition anchor in the Tipo column, not 'Tasación'", () => {
    const markup = renderFor(null, [acquisitionAnchor, appraisalAnchor]);
    expect(markup).toContain(">Adquisición</td>");
    expect(markup).toContain(">Tasación</td>");
  });

  test("renders a named acquisition editor prefilled with the stored anchor", () => {
    const markup = renderFor(null, [acquisitionAnchor]);
    expect(markup).toContain("Editar adquisición");
    expect(markup).toContain("Fecha de adquisición");
    expect(markup).toContain("Precio de adquisición (EUR)");
    expect(markup).toContain('name="anchorId" value="anchor_acquisition"');
    expect(markup).toContain('value="2004-05-19"');
    expect(markup).toContain('value="150253,03"');
  });

  test("the acquisition row offers no delete", () => {
    const markup = renderFor(null, [acquisitionAnchor, appraisalAnchor]);
    // Two rows render; only the plain appraisal keeps its two-step delete.
    expect((markup.match(/Confirmar/g) ?? []).length).toBe(1);
  });

  test("no named editor without an acquisition anchor", () => {
    const markup = renderFor(null, []);
    expect(markup).not.toContain("Fecha de adquisición");
  });

  test("an unmarked anchor keeps the plain Tasación row and delete", () => {
    const markup = renderFor(null, [appraisalAnchor]);
    expect(markup).not.toContain(">Adquisición</td>");
    expect(markup).toContain("Confirmar");
  });
});
