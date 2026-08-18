import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { InvestmentCapture } from "./investment-capture";

/**
 * The saldo pane's «Fecha del saldo» (#1395). Two structural facts this island
 * must keep, both of them regressions waiting to happen:
 *
 *  - It renders inside the ONE wizard form whose panes hide with `display:none`
 *    (ADR 0009), so the date input may NEVER be `required` — a required control in
 *    a hidden pane aborts native submit for every other drawer (#677's CRITICAL).
 *  - Its `max` is today: a saldo you have not had yet is not history, and the
 *    server refuses it — the calendar should not offer it in the first place.
 *
 * Asserted via `renderToStaticMarkup` (interaction-patterns §7: no jsdom/RTL in
 * this repo), which also covers the hint's server-rendered first paint.
 */

const TODAY = "2026-08-17";

function inputTag(markup: string, name: string): string {
  const match = new RegExp(`<input[^>]*name="${name}"[^>]*/?>`).exec(markup);
  if (!match) {
    throw new Error(`No <input name="${name}"> found in markup`);
  }
  return match[0];
}

function render(props: Partial<Parameters<typeof InvestmentCapture>[0]> = {}): string {
  return renderToStaticMarkup(
    <InvestmentCapture
      defaultDate=""
      defaultPrice="319,59"
      defaultSaldo=""
      instrument="fund"
      today={TODAY}
      {...props}
    />,
  );
}

describe("InvestmentCapture — «Fecha del saldo» (#1395)", () => {
  test("posts an optional date input capped at today, never required", () => {
    const tag = inputTag(render(), "saldoDate_fund");
    expect(tag).toContain('type="date"');
    expect(tag).toContain(`max="${TODAY}"`);
    expect(tag).not.toContain("required");
  });

  test("refills the typed date after a validation round-trip", () => {
    expect(inputTag(render({ defaultDate: "2026-07-31" }), "saldoDate_fund")).toContain(
      'value="2026-07-31"',
    );
  });

  test("the hint reads the units that WILL be persisted — six decimals, not twenty", () => {
    const markup = render({ defaultSaldo: "1.089,79" });
    expect(markup).toContain("3,409963 participaciones");
    expect(markup).not.toContain("3,4099627");
  });

  test("a past saldo date announces the history rebuild in the same hint", () => {
    const markup = render({ defaultDate: "2026-07-31", defaultSaldo: "1.089,79" });
    expect(markup).toContain("31 jul 2026");
    expect(markup).toContain("hist");
  });

  test("a backdated saldo re-labels BOTH figures against that date", () => {
    // The trap the field opens (review of #1395): the price field is prefilled with
    // the LIVE quote, so a saldo dated weeks ago would be divided by today's price
    // and the unit count would be wrong forever. Nothing but the copy can tell the
    // two apart, so both labels — and the price note — must name the date, and the
    // live-quote hint must be GONE (hence the real hint in this render).
    const markup = render({
      defaultDate: "2026-07-31",
      defaultSaldo: "1.089,79",
      priceHint: "Precio en vivo de Yahoo Finance.",
    });
    expect(markup).toContain("¿Cuánto tenías el 31 jul 2026?");
    expect(markup).toContain("Precio por participación el 31 jul 2026");
    expect(markup).toContain("valor liquidativo del 31 jul 2026");
    expect(markup).not.toContain("Precio en vivo");
  });

  test("an untouched live quote under a backdated saldo is CALLED OUT, not just asked for", () => {
    // The one state where the units come out wrong: the price is still, character
    // for character, today's quote. The pane says so instead of hoping.
    const markup = render({
      defaultDate: "2026-07-31",
      defaultPrice: "319,59",
      defaultSaldo: "1.089,79",
      livePrice: "319,59",
      priceHint: "Precio en vivo de Yahoo Finance.",
    });
    expect(markup).toContain("Ese precio es el de HOY");
    expect(markup).toContain("valor liquidativo del 31 jul 2026");
  });

  test("a price the user changed drops the call-out and just names the date", () => {
    const markup = render({
      defaultDate: "2026-07-31",
      defaultPrice: "312,40",
      defaultSaldo: "1.089,79",
      livePrice: "319,59",
    });
    expect(markup).not.toContain("Ese precio es el de HOY");
    expect(markup).toContain("Pon el valor liquidativo del 31 jul 2026");
  });

  test("with no date the pane keeps today's wording and the live-quote note", () => {
    const markup = render({
      livePrice: "319,59",
      priceHint: "Precio en vivo de Yahoo Finance.",
    });
    expect(markup).toContain("¿Cuánto tienes hoy?");
    expect(markup).toContain("Precio en vivo de Yahoo Finance.");
    expect(markup).not.toContain("valor liquidativo");
  });

  test("a refused date reads as a refusal, not as a neutral hint", () => {
    const markup = render({ defaultDate: "2026-02-30", defaultSaldo: "1.089,79" });
    expect(markup).toContain("invUnitsRefused");
    expect(markup).toContain("no es válida");
    // And it never invents the units of a capture the server would refuse.
    expect(markup).not.toContain("participaciones.");
  });
});
