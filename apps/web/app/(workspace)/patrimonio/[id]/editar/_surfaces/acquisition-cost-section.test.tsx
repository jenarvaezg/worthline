import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AcquisitionCostSection } from "./acquisition-cost-section";

/**
 * The ficha's acquisition-cost surface (#1441). Two things are being pinned: the
 * fiscal boundary is SAID (in the help text, not as extra inputs), and the result
 * line exists only when a cost does — a property whose cost nobody has typed shows
 * no return rather than a fabricated 0 %.
 */
function renderFor(acquisitionCostMinor: number | null, currentValueMinor: number) {
  return renderToStaticMarkup(
    <AcquisitionCostSection
      acquisitionCostMinor={acquisitionCostMinor}
      assetId="a_yeles"
      currency="EUR"
      currentUrl="/patrimonio/wl_hld_a_yeles/editar"
      currentValueMinor={currentValueMinor}
      formError={null}
    />,
  );
}

describe("AcquisitionCostSection — el campo y su frontera fiscal (#1441)", () => {
  test("offers the cost field with the mortgage explicitly left out", () => {
    const markup = renderFor(null, 48_000_00);

    expect(markup).toContain("Coste de adquisición (EUR)");
    expect(markup).toContain(
      "ITP, notaría, registro y gestoría. No la hipoteca ni sus comisiones.",
    );
  });

  test("no breakdown inputs — one field, by decision", () => {
    const markup = renderFor(null, 48_000_00);

    expect(markup).not.toContain('name="itp"');
    expect(markup).not.toContain('name="notaria"');
    expect(markup).not.toContain('name="registro"');
  });

  test("prefills the stored cost as an editable amount", () => {
    const markup = renderFor(53_354_55, 48_000_00);

    expect(markup).toContain('value="53354,55"');
  });
});

describe("AcquisitionCostSection — resultado frente al coste (#1441)", () => {
  test("Yeles: value 48.000 under a cost of 53.354,55 reads negative", () => {
    const markup = renderFor(53_354_55, 48_000_00);

    expect(markup).toContain("Resultado frente al coste");
    expect(markup).toContain('aria-label="Resultado frente al coste de adquisición"');
    expect(markup).toContain('class="neg"');
    // The sign is in the text too, never colour alone (design-system §6). Whole
    // euros are the app's reading voice for a derived figure (formatMoneyMinor),
    // and es-ES does not group a four-digit amount. (The space before € is a
    // non-breaking one, so the assertion stops at the digits.)
    expect(markup).toContain(">-5355");
    expect(markup).not.toContain('class="pos"');
  });

  test("a property worth more than it cost reads positive, with an explicit +", () => {
    const markup = renderFor(110_718_95, 150_000_00);

    expect(markup).toContain('class="pos"');
    expect(markup).toContain(">+39.281");
  });

  test("without a cost there is no result line — no invented 0 %", () => {
    const markup = renderFor(null, 48_000_00);

    expect(markup).not.toContain("Resultado frente al coste");
    expect(markup).not.toContain('class="pos"');
    expect(markup).not.toContain('class="neg"');
  });

  test("without a current value there is no result line either", () => {
    // «solo si hay coste y hay valor actual»: a property with no value yet would
    // otherwise read as a total loss of everything disbursed.
    const markup = renderFor(53_354_55, 0);

    expect(markup).not.toContain("Resultado frente al coste");
    expect(markup).not.toContain('class="neg"');
  });

  test("no three-measure returns panel here — one line, by decision", () => {
    const markup = renderFor(53_354_55, 48_000_00);

    expect(markup).not.toContain("returnsPanel");
    expect(markup).not.toContain("IRR");
    expect(markup).not.toContain("TWR");
  });
});
