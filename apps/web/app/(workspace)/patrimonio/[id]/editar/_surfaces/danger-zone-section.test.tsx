import type { HoldingTrashImpact } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { DangerZoneSection } from "./danger-zone-section";

/**
 * Sending a holding to the Papelera used to say only "podrás recuperarlo" — true,
 * reassuring, and silent about the part that matters: with units still inside, the
 * value leaves the patrimonio at the next capture with no sale, traspaso, or
 * deposit recorded (#1365). #1549 turned that warning into a door with three exits.
 * The two cases must read differently; the clean one must not gain a single step.
 */
const CURRENT_URL = "/patrimonio/wl_hld_fondo/editar";
const TRANSFER_HREF = `${CURRENT_URL}?abrir=traspaso&archivar=1#traspaso`;
const TODAY = "2026-08-23";

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
        today={TODAY}
        transferHref={TRANSFER_HREF}
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
    expect(html).not.toContain("¿Qué pasó con este activo?");
  });

  test("a debt keeps its own copy — a liability has no units to sell", () => {
    const html = render(null, "liability");

    expect(html).toContain("La deuda se moverá a la Papelera y podrás recuperarla.");
    expect(html).toContain("Eliminar deuda");
  });

  test("the clean case is one confirm and one button — no exit to choose", () => {
    const html = render(null, "asset");

    expect(html).toContain("<summary>Eliminar activo</summary>");
    expect(html.match(/Confirmar eliminación/g)).toHaveLength(1);
    expect(html).not.toContain('name="exit"');
  });
});

describe("DangerZoneSection — the whole truth when there is money inside (#1365)", () => {
  test("names the units, the value leaving, and that nothing records where it went", () => {
    const html = render(IMPACT, "asset");

    expect(html).toContain("120,5 participaciones");
    // No thousands separator asserted: the test runtime's ICU renders "4320 €"
    // where the browser renders "4.320 €" (same convention as the #1290 tests).
    expect(html).toContain("4320");
    expect(html).toContain("sale de tu patrimonio en la próxima captura");
    expect(html).toContain("no hay venta, ni traspaso, ni ingreso en ninguna cuenta");
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
        today={TODAY}
        transferHref={TRANSFER_HREF}
        trashImpact={IMPACT}
      />,
    );

    expect(html).not.toContain("4320");
    expect(html).toContain("120,5 participaciones");
  });
});

describe("DangerZoneSection — the door's three exits (#1549)", () => {
  test("offers exactly the three exits, none of them preselected", () => {
    const html = render(IMPACT, "asset");

    for (const exit of ["sold", "transferred", "mis_entry"]) {
      expect(html).toContain(`value="${exit}"`);
    }
    expect(html).not.toContain("checked");
  });

  test("«lo vendí» asks only for the two figures a confirmation states", () => {
    const html = render(IMPACT, "asset");

    expect(html).toContain('name="soldAt"');
    expect(html).toContain('name="soldAmount"');
    expect(html).toContain(`value="${TODAY}"`);
    expect(html).toContain("Registrar la venta y eliminar");
  });

  test("no field carries a native `required` — a hidden one aborts every submit (#677)", () => {
    expect(render(IMPACT, "asset")).not.toContain("required");
  });

  test("«lo traspasé» links to the traspaso surface carrying the archive intent", () => {
    const html = render(IMPACT, "asset");

    expect(html).toContain(TRANSFER_HREF.replace(/&/g, "&amp;"));
  });

  test("with no traspaso surface on the ficha, that exit is not offered at all", () => {
    const html = renderToStaticMarkup(
      <DangerZoneSection
        currentUrl={CURRENT_URL}
        holdingId="asset_fondo"
        kind="asset"
        privacyMode={false}
        today={TODAY}
        transferHref={null}
        trashImpact={IMPACT}
      />,
    );

    expect(html).not.toContain('value="transferred"');
    expect(html).toContain('value="sold"');
  });

  test("«error de registro» says what it archives and what it costs", () => {
    const html = render(IMPACT, "asset");

    expect(html).toContain("ese valor nunca existió");
    expect(html).toContain("Eliminar sin operación");
  });
});

describe("DangerZoneSection — a refused exit comes back intact (#1329)", () => {
  test("reopens the door, keeps the exit chosen and the figures typed", () => {
    const html = renderToStaticMarkup(
      <DangerZoneSection
        currentUrl={CURRENT_URL}
        formError={{
          formId: "trash",
          message: "Escribe el importe que recibiste por la venta.",
          values: { exit: "sold", soldAmount: "7642,00", soldAt: "2026-08-01" },
        }}
        holdingId="asset_fondo"
        kind="asset"
        privacyMode={false}
        today={TODAY}
        transferHref={TRANSFER_HREF}
        trashImpact={IMPACT}
      />,
    );

    // An error band above a folded <details> answers a question nobody can see.
    expect(html).toContain('<details class="confirmDelete" open=""');
    expect(html).toContain("Escribe el importe que recibiste");
    expect(html).toContain('name="exit" checked="" value="sold"');
    expect(html).toContain('value="7642,00"');
    expect(html).toContain('value="2026-08-01"');
  });

  test("an error from ANOTHER form leaves the door shut and empty", () => {
    const html = renderToStaticMarkup(
      <DangerZoneSection
        currentUrl={CURRENT_URL}
        formError={{
          formId: "transfer",
          message: "El importe supera la posición.",
          values: { amount: "999" },
        }}
        holdingId="asset_fondo"
        kind="asset"
        privacyMode={false}
        today={TODAY}
        transferHref={TRANSFER_HREF}
        trashImpact={IMPACT}
      />,
    );

    expect(html).not.toContain('open=""');
    expect(html).not.toContain("El importe supera la posición");
    expect(html).not.toContain("checked");
  });
});

describe("DangerZoneSection — a cartera's cash box has no door (#1549)", () => {
  test("names the portfolio and offers no delete at all", () => {
    const html = renderToStaticMarkup(
      <DangerZoneSection
        containerPortfolio="Cartera Indexada Metal"
        currentUrl={CURRENT_URL}
        holdingId="asset_cash"
        kind="asset"
        privacyMode={false}
        today={TODAY}
        trashImpact={null}
      />,
    );

    expect(html).toContain("Cartera Indexada Metal");
    expect(html).toContain("la casilla queda como una cuenta normal");
    expect(html).not.toContain("Eliminar activo");
  });
});
