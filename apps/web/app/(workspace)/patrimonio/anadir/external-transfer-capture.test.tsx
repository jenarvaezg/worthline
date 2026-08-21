import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ExternalTransferCapture } from "./external-transfer-capture";

/**
 * The «viene traspasada de otra entidad» pane (#1541). The structural facts it has to
 * keep are the sibling saldo pane's, for the same reasons:
 *
 *  - It renders inside the ONE wizard form whose panes hide with `display:none`
 *    (ADR 0009), so NO control in it may ever be `required` — a required control in
 *    a hidden pane aborts native submit for every other drawer (#677's CRITICAL).
 *  - The date's `max` is today: capital that has not landed yet is not history, and
 *    the server refuses it, so the calendar must not offer it.
 *
 * Asserted via `renderToStaticMarkup` (interaction-patterns §7: no jsdom/RTL here),
 * which also covers the copy's server-rendered first paint.
 */

const TODAY = "2026-06-15";

function inputTag(markup: string, name: string): string {
  const match = new RegExp(`<input[^>]*name="${name}"[^>]*/?>`).exec(markup);
  if (!match) {
    throw new Error(`No <input name="${name}"> found in markup`);
  }
  return match[0];
}

function render(
  props: Partial<Parameters<typeof ExternalTransferCapture>[0]> = {},
): string {
  return renderToStaticMarkup(
    <ExternalTransferCapture
      defaultAmount=""
      defaultCost=""
      defaultDate=""
      defaultPrice=""
      instrument="pension_plan"
      today={TODAY}
      {...props}
    />,
  );
}

describe("ExternalTransferCapture", () => {
  test("posts the four fields the entry needs, suffixed so the hidden panes never collide", () => {
    const markup = render();

    for (const name of [
      "trAmount_pension_plan",
      "trDate_pension_plan",
      "trPrice_pension_plan",
      "trCost_pension_plan",
    ]) {
      expect(() => inputTag(markup, name)).not.toThrow();
    }
  });

  test("no control is required — the hidden-pane trap (#677)", () => {
    expect(render()).not.toContain("required");
  });

  test("the date is capped at today and shows it explicitly", () => {
    const tag = inputTag(render(), "trDate_pension_plan");

    expect(tag).toContain('type="date"');
    expect(tag).toContain(`max="${TODAY}"`);
    expect(tag).toContain(`value="${TODAY}"`);
  });

  test("the first paint already reads the participaciones that will be stored", () => {
    const markup = render({
      defaultAmount: "95,46",
      defaultDate: "2026-01-23",
      defaultPrice: "12,50",
    });

    expect(markup).toContain("7,6368 participaciones");
    expect(markup).toContain("23 ene 2026");
  });

  test("an empty cost says what leaving it empty means, before anyone asks", () => {
    const markup = render({ defaultAmount: "95,46", defaultPrice: "12,50" });

    expect(markup).toContain("sin plusvalía latente inventada");
  });

  test("refills the four figures after a validation round-trip (#1329)", () => {
    const markup = render({
      defaultAmount: "95,46",
      defaultCost: "80,00",
      defaultDate: "2026-01-23",
      defaultPrice: "12,50",
    });

    expect(inputTag(markup, "trAmount_pension_plan")).toContain('value="95,46"');
    expect(inputTag(markup, "trCost_pension_plan")).toContain('value="80,00"');
    expect(inputTag(markup, "trDate_pension_plan")).toContain('value="2026-01-23"');
    expect(inputTag(markup, "trPrice_pension_plan")).toContain('value="12,50"');
  });
});
