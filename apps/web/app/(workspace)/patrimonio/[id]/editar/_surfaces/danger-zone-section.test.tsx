import type { HoldingTrashImpact } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { DangerZoneSection } from "./danger-zone-section";

/**
 * Sending a holding to the Papelera used to say only "podrás recuperarlo" — true,
 * reassuring, and silent about the part that matters: with units still inside, the
 * value leaves the patrimonio at the next capture with no sale, traspaso, or
 * deposit recorded (#1365). The two cases must read differently; the clean one must
 * not gain a single step.
 */
const CURRENT_URL = "/patrimonio/wl_hld_fondo/editar";

function render(trashImpact: HoldingTrashImpact | null, kind: "asset" | "liability") {
  // The props are discriminated on `kind`: only an asset can carry an impact, so
  // the debt case cannot even be written with one.
  return renderToStaticMarkup(
    kind === "asset" ? (
      <DangerZoneSection
        currentUrl={CURRENT_URL}
        holdingId="asset_fondo"
        kind="asset"
        privacyMode={false}
        trashImpact={trashImpact}
      />
    ) : (
      <DangerZoneSection
        currentUrl={CURRENT_URL}
        holdingId="liab_hipoteca"
        kind="liability"
        privacyMode={false}
      />
    ),
  );
}

const IMPACT: HoldingTrashImpact = {
  basis: "market",
  netUnits: "120.5",
  value: { amountMinor: 4_320_15, currency: "EUR" },
};

describe("DangerZoneSection — the clean delete stays clean (#1365)", () => {
  test("a holding with nothing inside keeps the original copy, unchanged", () => {
    const html = render(null, "asset");

    expect(html).toContain("El activo se moverá a la Papelera y podrás recuperarlo.");
    expect(html).not.toContain("sale de tu patrimonio");
    expect(html).not.toContain("Registrar la venta");
  });

  test("a debt keeps its own copy — a liability has no units to sell", () => {
    const html = render(null, "liability");

    expect(html).toContain("La deuda se moverá a la Papelera y podrás recuperarla.");
    expect(html).toContain("Eliminar deuda");
  });

  test("both cases stay a two-step confirm — the friction is words, not clicks", () => {
    for (const html of [render(null, "asset"), render(IMPACT, "asset")]) {
      expect(html).toContain("<summary>Eliminar activo</summary>");
      expect(html.match(/Confirmar eliminación/g)).toHaveLength(1);
    }
  });
});

describe("DangerZoneSection — the whole truth when there is money inside (#1365)", () => {
  test("names the units, the value leaving, and that nothing records where it went", () => {
    const html = render(IMPACT, "asset");

    expect(html).toContain("120,5 unidades");
    // No thousands separator asserted: the test runtime's ICU renders "4320 €"
    // where the browser renders "4.320 €" (same convention as the #1290 tests).
    expect(html).toContain("4320");
    expect(html).toContain("sale de tu patrimonio en la próxima captura");
    expect(html).toContain("no hay venta, ni traspaso, ni ingreso en ninguna cuenta");
  });

  test("offers the correct exit as a working link into the operations surface", () => {
    const html = render(IMPACT, "asset");

    expect(html).toContain("Registrar la venta");
    // `?abrir=operaciones` unfolds the advanced block server-side; a bare fragment
    // would scroll to a collapsed <details> and reveal nothing.
    expect(html).toContain(
      `href="${CURRENT_URL}?abrir=operaciones#operaciones"`.replace(/&/g, "&amp;"),
    );
  });

  test("says when the figure is a cost basis rather than a market valuation", () => {
    const html = render({ ...IMPACT, basis: "cost" }, "asset");

    expect(html).toContain("valoradas a coste en");
  });

  test("the figure obeys privacy mode", () => {
    const html = renderToStaticMarkup(
      <DangerZoneSection
        currentUrl={CURRENT_URL}
        holdingId="asset_fondo"
        kind="asset"
        privacyMode
        trashImpact={IMPACT}
      />,
    );

    expect(html).not.toContain("4320");
    expect(html).toContain("120,5 unidades");
  });
});
