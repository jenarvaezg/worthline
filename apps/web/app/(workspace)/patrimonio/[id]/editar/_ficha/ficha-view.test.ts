import { describe, expect, test } from "vitest";

import {
  claimFichaOpen,
  type FichaViewSpec,
  fichaActionUrl,
  fichaTabUrl,
  readFichaView,
  writeFichaView,
} from "./ficha-view";

/**
 * What the ficha is showing lives in the URL (#1826, interaction-patterns §3): which
 * tab (`?pestaña=`) and which action's panel (`?accion=`). The links that already
 * exist keep landing where they promised — `?abrir=operaciones`, `?abrir=cobros` and
 * the Papelera's `?abrir=traspaso&archivar=1` — and a refusal that comes back in
 * the URL reopens the form that produced it, or its band would be behind a closed
 * panel.
 */

const INVESTMENT: FichaViewSpec = {
  actions: ["operacion", "traspaso", "cobro", "entrada", "extracto", "correccion"],
  errorTargets: {
    edit: { tab: "datos" },
    payout: { tab: "cobros" },
    transfer: { action: "traspaso" },
  },
  tabs: ["operaciones", "rentabilidad", "cobros", "datos"],
};

const read = (query: string, spec: FichaViewSpec = INVESTMENT) =>
  readFichaView(new URLSearchParams(query), spec);

describe("readFichaView", () => {
  test("a bare ficha opens on its first tab with no panel", () => {
    expect(read("")).toEqual({ action: null, tab: "operaciones" });
  });

  test("?pestaña= names a tab, and only one the ficha has", () => {
    expect(read("pesta%C3%B1a=cobros").tab).toBe("cobros");
    // Typed by hand without the eñe, it still lands.
    expect(read("pestana=datos").tab).toBe("datos");
    expect(read("pesta%C3%B1a=hipoteca").tab).toBe("operaciones");
  });

  test("?accion= opens one action, and only one the ficha offers", () => {
    expect(read("accion=traspaso").action).toBe("traspaso");
    // «Rellenar histórico» is offered only to a candidate; a stale link to it on a
    // holding that is not one opens nothing rather than an empty panel.
    expect(read("accion=historico").action).toBeNull();
  });

  test("the three ?abrir= links land where they always did", () => {
    expect(read("abrir=operaciones")).toEqual({ action: null, tab: "operaciones" });
    expect(read("abrir=cobros")).toEqual({ action: null, tab: "cobros" });
    expect(read("abrir=traspaso&archivar=1")).toEqual({
      action: "traspaso",
      tab: "operaciones",
    });
  });

  test("?abrir=traspaso on a ficha that cannot traspasar opens nothing", () => {
    const noLedger = { ...INVESTMENT, actions: ["operacion", "cobro", "extracto"] };
    expect(read("abrir=traspaso", noLedger).action).toBeNull();
  });

  test("a refusal reopens the form that produced it", () => {
    expect(read("error=Falta+el+destino&form=transfer").action).toBe("traspaso");
    expect(read("error=Falta+el+nombre&form=edit").tab).toBe("datos");
    // `form` alone is not a refusal: with no message there is nothing to show.
    expect(read("form=transfer").action).toBeNull();
    // A form the ficha does not place stays where the page band can print it.
    expect(read("error=Algo&form=desconocido")).toEqual({
      action: null,
      tab: "operaciones",
    });
  });

  test("an explicit ?pestaña= or ?accion= wins over what a link or a refusal implies", () => {
    expect(read("pesta%C3%B1a=rentabilidad&abrir=cobros").tab).toBe("rentabilidad");
    expect(read("accion=cobro&error=x&form=transfer").action).toBe("cobro");
  });
});

describe("writeFichaView", () => {
  test("opening an action keeps the tab and every unrelated param", () => {
    expect(
      writeFichaView("?pesta%C3%B1a=cobros&ok=saved", INVESTMENT, { action: "cobro" }),
    ).toBe("?pesta%C3%B1a=cobros&ok=saved&accion=cobro");
  });

  test("the first tab is omitted, so switching back reproduces the clean URL", () => {
    expect(
      writeFichaView("?pesta%C3%B1a=cobros", INVESTMENT, { tab: "operaciones" }),
    ).toBe("");
  });

  test("closing the panel also drops the link or refusal that had opened it", () => {
    // Otherwise the URL would keep reopening it: a reload after «Cerrar» would
    // bring the panel back, and so would the Back button's next stop.
    expect(
      writeFichaView("?abrir=traspaso&archivar=1", INVESTMENT, { action: null }),
    ).toBe("?archivar=1");
    expect(
      writeFichaView("?error=Falta&form=transfer&v_units=3", INVESTMENT, {
        action: null,
      }),
    ).toBe("");
  });

  test("switching tab with a linked panel open keeps the panel, now said explicitly", () => {
    expect(
      writeFichaView("?abrir=traspaso&archivar=1", INVESTMENT, { tab: "cobros" }),
    ).toBe("?archivar=1&pesta%C3%B1a=cobros&accion=traspaso");
  });
});

describe("fichaTabUrl", () => {
  test("a form returns to the tab it lands on — the first one is the bare URL", () => {
    const base = "/patrimonio/wl_hld_fondo/editar";

    expect(fichaTabUrl(base, INVESTMENT.tabs, "operaciones")).toBe(base);
    expect(fichaTabUrl(base, INVESTMENT.tabs, "cobros")).toBe(
      `${base}?pesta%C3%B1a=cobros`,
    );
  });
});

/**
 * A link to where something is fixed (#1828) — «Indicar símbolo», «Ver
 * operaciones» — asks the ficha to show a tab. The ficha claims only a tab it has,
 * and showing it closes whatever panel was open: the fix is on the tab, not behind
 * a sheet.
 */
describe("claimFichaOpen", () => {
  test("a tab the ficha has is shown, and the open panel closes", () => {
    expect(claimFichaOpen({ field: "providerSymbol", tab: "datos" }, INVESTMENT)).toEqual(
      {
        action: null,
        tab: "datos",
      },
    );
  });

  test("a tab it does not have is left to the link", () => {
    expect(claimFichaOpen({ tab: "valoracion" }, INVESTMENT)).toBeNull();
  });
});

describe("fichaActionUrl", () => {
  test("a link to an action opens its panel over the tab it was printed on (#1830)", () => {
    const base = "/patrimonio/wl_hld_fondo/editar";

    expect(fichaActionUrl(base, INVESTMENT.tabs, "cobros", "cobro")).toBe(
      `${base}?pesta%C3%B1a=cobros&accion=cobro`,
    );
    // On the first tab the tab is the bare URL, as everywhere else.
    expect(fichaActionUrl(base, INVESTMENT.tabs, "operaciones", "operacion")).toBe(
      `${base}?accion=operacion`,
    );
    // What the island reads back is that very view.
    expect(
      readFichaView(
        new URL(
          fichaActionUrl(base, INVESTMENT.tabs, "cobros", "cobro"),
          "https://worthline.test",
        ).searchParams,
        INVESTMENT,
      ),
    ).toEqual({ action: "cobro", tab: "cobros" });
  });
});
