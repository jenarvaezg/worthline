import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { InvestmentCapture } from "./investment-capture";

/**
 * The saldo pane's date (#1395) and acquisition cost (#1490). Two structural facts
 * this island must keep, both of them regressions waiting to happen:
 *
 *  - It renders inside the ONE wizard form whose panes hide with `display:none`
 *    (ADR 0009), so NO control in it may ever be `required` — a required control in
 *    a hidden pane aborts native submit for every other drawer (#677's CRITICAL).
 *  - The date's `max` is today: a position you do not have yet is not history, and
 *    the server refuses it — the calendar should not offer it in the first place.
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

describe("InvestmentCapture — «¿Desde cuándo la tienes?» (#1395, #1490)", () => {
  test("posts a date input capped at today, never required", () => {
    const tag = inputTag(render(), "saldoDate_fund");
    expect(tag).toContain('type="date"');
    expect(tag).toContain(`max="${TODAY}"`);
    expect(tag).not.toContain("required");
  });

  test("shows today EXPLICITLY instead of an empty field that silently means today", () => {
    // How a position bought in December got dated in August: the field was blank and
    // the default was invisible, so nobody ever disagreed with it (#1490).
    expect(inputTag(render(), "saldoDate_fund")).toContain(`value="${TODAY}"`);
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

  test("a past date announces the history rebuild in the same hint", () => {
    const markup = render({ defaultDate: "2026-07-31", defaultSaldo: "1.089,79" });
    expect(markup).toContain("31 jul 2026");
    expect(markup).toContain("hist");
  });

  test("the two money fields stay TODAY's — the cost is asked for separately", () => {
    // The saldo and the price fix how many participaciones there are, so they are
    // read as of today whatever the date says; what a backdated position needs is
    // its COST, and that is its own field (#1490).
    const markup = render({
      defaultDate: "2026-07-31",
      defaultSaldo: "1.089,79",
      priceHint: "Precio en vivo de Yahoo Finance.",
    });
    expect(markup).toContain("¿Cuánto tienes hoy?");
    expect(markup).toContain("Precio por participación (€)");
    expect(markup).toContain("Precio en vivo de Yahoo Finance.");
  });

  test("a refused date reads as a refusal, not as a neutral hint", () => {
    const markup = render({ defaultDate: "2026-02-30", defaultSaldo: "1.089,79" });
    expect(markup).toContain("invUnitsRefused");
    expect(markup).toContain("no es válida");
    // And it never invents the units of a capture the server would refuse.
    expect(markup).not.toContain("participaciones.");
  });
});

describe("InvestmentCapture — el coste de adquisición (#1490)", () => {
  test("posts an optional cost and its mode, neither of them required", () => {
    const markup = render();
    expect(inputTag(markup, "cost_fund")).not.toContain("required");
    expect(markup).toContain('name="costMode_fund"');
    expect(markup).toContain('value="total"');
    expect(markup).toContain('value="unit"');
  });

  test("an empty cost says what that MEANS instead of leaving a blank", () => {
    const markup = render({ defaultSaldo: "1.089,79" });
    expect(markup).toContain("Sin coste no habrá plusvalía");
  });

  test("a declared total is read back as a unit price and as the latent gain", () => {
    // Jorge's real alta: 27 uds worth 5.865,75 € today, bought for 4.999,86 €.
    const markup = render({
      defaultCost: "4.999,86",
      defaultPrice: "217,25",
      defaultSaldo: "5.865,75",
    });
    expect(markup).toContain("por participación");
    expect(markup).toContain("plusval");
    expect(markup).toContain("865,89");
  });

  test("a cost declared per participación keeps that mode checked after a round-trip", () => {
    const markup = render({
      defaultCost: "185,18",
      defaultCostMode: "unit",
      defaultPrice: "217,25",
      defaultSaldo: "5.865,75",
    });
    expect(markup).toContain("de coste total");
    expect(inputTag(markup, "costMode_fund")).not.toContain("checked");
    expect(markup).toContain("865,89");
  });
});
