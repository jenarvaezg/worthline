import { describe, expect, test } from "vitest";

import { landedOk, panelSubmission } from "./ficha-again";

/**
 * «Añadir otra» (#1829): after registering from the side panel, the success notice
 * offers to open the same form again, keeping the date and the currency — the two
 * things a run of buys typed off one broker statement shares. So the ficha has to
 * remember what the panel sent, and tell the terminal of THAT submit apart from any
 * other success that lands on the ficha.
 */

const FICHA = "/patrimonio/wl_hld_fondo/editar";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const OPERATION = form({
  currency: "USD",
  currentUrl: FICHA,
  executedAt: "2026-09-12",
  fees: "1",
  kind: "buy",
  pricePerUnit: "106,65",
  units: "5",
});

describe("panelSubmission", () => {
  test("an operation keeps its date and its currency, never its figures", () => {
    expect(panelSubmission("operacion", OPERATION)).toEqual({
      action: "operacion",
      returnUrl: FICHA,
      seed: { values: { currency: "USD", executedAt: "2026-09-12" } },
    });
  });

  test("a cobro keeps its date and which of its two forms was used", () => {
    const cobro = form({
      amount: "12,50",
      currentUrl: `${FICHA}?pesta%C3%B1a=cobros`,
      dateISO: "2026-10-01",
      note: "",
    });

    expect(panelSubmission("cobro", cobro, "suelto")?.seed).toEqual({
      choice: "suelto",
      values: { dateISO: "2026-10-01" },
    });
  });

  test("a form that posts no return URL has no terminal to recognise", () => {
    expect(panelSubmission("operacion", form({ units: "5" }))).toBeNull();
  });
});

describe("landedOk", () => {
  const submitted = panelSubmission("operacion", OPERATION);
  const cobro = panelSubmission(
    "cobro",
    form({ currentUrl: `${FICHA}?pesta%C3%B1a=cobros`, dateISO: "2026-10-01" }),
  );
  if (!submitted || !cobro) throw new Error("fixtures must be submissions");

  test("the success terminal is the return URL with its `ok`", () => {
    expect(landedOk(submitted, { pathname: FICHA, search: "?ok=saved" })).toBe("saved");
    // Spelled however the island reads it: `useSearchParams` re-encodes the eñe.
    expect(
      landedOk(cobro, { pathname: FICHA, search: "ok=payout_saved&pesta%C3%B1a=cobros" }),
    ).toBe("payout_saved");
  });

  test("a refusal that came back in the URL is not a success", () => {
    expect(
      landedOk(submitted, {
        pathname: FICHA,
        search: "?error=Las+unidades+son+obligatorias.&form=operation",
      }),
    ).toBeNull();
  });

  test("another form's success on the same ficha is not this one's", () => {
    // «Lo básico» returns to «Datos del activo» with the same `ok=saved`.
    expect(
      landedOk(submitted, {
        pathname: FICHA,
        search: "?pesta%C3%B1a=datos&ok=saved",
      }),
    ).toBeNull();
    expect(
      landedOk(submitted, {
        pathname: "/patrimonio/wl_hld_otro/editar",
        search: "?ok=saved",
      }),
    ).toBeNull();
  });

  test("the URL it left from, still without an `ok`, is not a landing yet", () => {
    expect(
      landedOk(submitted, { pathname: FICHA, search: "?accion=operacion" }),
    ).toBeNull();
    expect(landedOk(submitted, { pathname: FICHA, search: "" })).toBeNull();
  });
});
