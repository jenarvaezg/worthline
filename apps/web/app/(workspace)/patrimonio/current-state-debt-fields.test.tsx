import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { CurrentStateDebtFields } from "./current-state-debt-fields";

/**
 * Regression for the #677 final-gate review (CRITICAL): the wizard is ONE
 * form (anadir/page.tsx) with no `noValidate`, and its panes toggle via CSS
 * `display:none` — every pane's inputs stay in the DOM. A `required` control
 * inside a hidden pane aborts native submit in Chrome/Firefox ("not
 * focusable"), silently blocking every OTHER drawer (dinero, inversión,
 * inmueble, bien, tarjeta). `submitLabel` is the signal for "this island owns
 * its own submit" (the advanced edit surface); the wizard omits it and must
 * never mark these three inputs `required` — server validation (the balance
 * parse + `deriveCurrentStateDebt`) covers it there instead.
 *
 * Asserted via `renderToStaticMarkup` (the established pattern for this
 * component's structure, e.g. debt-model-section.test.tsx) rather than
 * jsdom/RTL — this repo's interaction-patterns §7 convention, and neither is
 * an installed dependency here.
 */
const REQUIRED_FIELD_NAMES = ["csOutstandingBalance", "csEndDate", "csNextPaymentDate"];

function inputTag(markup: string, name: string): string {
  const match = new RegExp(`<input[^>]*name="${name}"[^>]*/?>`).exec(markup);
  if (!match) {
    throw new Error(`No <input name="${name}"> found in markup`);
  }
  return match[0];
}

describe("CurrentStateDebtFields — required only on the edit surface (#677 final gate)", () => {
  test("the wizard mount (no submitLabel) renders the three fields WITHOUT required", () => {
    const markup = renderToStaticMarkup(
      <CurrentStateDebtFields baselineDate="2026-07-02" idPrefix="wizard-deuda" />,
    );

    for (const name of REQUIRED_FIELD_NAMES) {
      expect(inputTag(markup, name)).not.toContain("required");
    }
  });

  test("the advanced edit mount (submitLabel present) keeps required on the three fields", () => {
    const markup = renderToStaticMarkup(
      <CurrentStateDebtFields
        baselineDate="2026-07-02"
        idPrefix="plan-l1"
        submitLabel="Guardar por estado actual"
      />,
    );

    for (const name of REQUIRED_FIELD_NAMES) {
      expect(inputTag(markup, name)).toContain("required");
    }
  });
});
