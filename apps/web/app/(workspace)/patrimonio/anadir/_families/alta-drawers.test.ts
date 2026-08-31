/**
 * The alta's disclosure table and its generated reveal CSS (#1700).
 *
 * Two things are pinned here, and the second is the reason the module exists:
 *
 * 1. **Zero visual change.** The generated stylesheet is asserted against the
 *    exact literal the page used to inline, rule for rule and byte for byte.
 * 2. **The pairing is by construction.** For every drawer, group, mode and debt
 *    block, the selector the CSS emits is built from the SAME props the pane
 *    spreads onto its wrapper — so a renamed class cannot break the visibility in
 *    silence any more: it either breaks both halves or neither.
 */

import { describe, expect, test } from "vitest";
import {
  altaRevealCss,
  DEBT_KIND_FIELD,
  DEBT_KINDS,
  DRAWER_EMPTY_PROPS,
  DRAWER_FIELD,
  DRAWERS,
  debtBlockProps,
  drawerPaneProps,
  GROUP_EMPTY_PROPS,
  GROUP_FIELD,
  groupPaneProps,
  INVESTMENT_GROUPS,
  INVESTMENT_MODES,
  isNonDefaultInvestmentMode,
  modeField,
  modePaneProps,
} from "./alta-drawers";

/** The stylesheet the page inlined before the extraction, verbatim. */
const EXPECTED_CSS = [
  `.simpleAdd:has(input[name="simpleDrawer"]:checked) .simpleAddEmpty{display:none}`,
  `.simpleAdd:has(input[name="simpleDrawer"][value="dinero"]:checked) .simpleDrawerPane[data-drawer="dinero"]{display:grid}`,
  `.simpleAdd:has(input[name="simpleDrawer"][value="inversion"]:checked) .simpleDrawerPane[data-drawer="inversion"]{display:grid}`,
  `.simpleAdd:has(input[name="simpleDrawer"][value="inmueble"]:checked) .simpleDrawerPane[data-drawer="inmueble"]{display:grid}`,
  `.simpleAdd:has(input[name="simpleDrawer"][value="bien"]:checked) .simpleDrawerPane[data-drawer="bien"]{display:grid}`,
  `.simpleAdd:has(input[name="simpleDrawer"][value="deuda"]:checked) .simpleDrawerPane[data-drawer="deuda"]{display:grid}`,
  `.simpleAdd:has(input[name="instrument"]:checked) .invGroupEmpty{display:none}`,
  `.simpleAdd:has(input[name="instrument"][value="fund"]:checked) .invGroupPane[data-group="fund"]{display:grid}`,
  `.invGroupPane[data-group="fund"]:has(input[name="invMode_fund"][value="saldo"]:checked) .invModePane[data-mode="saldo"]{display:grid}`,
  `.invGroupPane[data-group="fund"]:has(input[name="invMode_fund"][value="import"]:checked) .invModePane[data-mode="import"]{display:block}`,
  `.invGroupPane[data-group="fund"]:has(input[name="invMode_fund"][value="traspaso"]:checked) .invModePane[data-mode="traspaso"]{display:grid}`,
  `.simpleAdd:has(input[name="instrument"][value="pension_plan"]:checked) .invGroupPane[data-group="pension_plan"]{display:grid}`,
  `.invGroupPane[data-group="pension_plan"]:has(input[name="invMode_pension_plan"][value="saldo"]:checked) .invModePane[data-mode="saldo"]{display:grid}`,
  `.invGroupPane[data-group="pension_plan"]:has(input[name="invMode_pension_plan"][value="import"]:checked) .invModePane[data-mode="import"]{display:block}`,
  `.invGroupPane[data-group="pension_plan"]:has(input[name="invMode_pension_plan"][value="traspaso"]:checked) .invModePane[data-mode="traspaso"]{display:grid}`,
  `.simpleAdd:has(input[name="instrument"][value="crypto"]:checked) .invGroupPane[data-group="crypto"]{display:grid}`,
  `.invGroupPane[data-group="crypto"]:has(input[name="invMode_crypto"][value="saldo"]:checked) .invModePane[data-mode="saldo"]{display:grid}`,
  `.invGroupPane[data-group="crypto"]:has(input[name="invMode_crypto"][value="import"]:checked) .invModePane[data-mode="import"]{display:block}`,
  `.invGroupPane[data-group="crypto"]:has(input[name="invMode_crypto"][value="traspaso"]:checked) .invModePane[data-mode="traspaso"]{display:grid}`,
  `.simpleDrawerPane[data-drawer="deuda"]:has(input[name="simpleDebtKind"][value="mortgage"]:checked) .debtSimpleBalanceField{display:none}`,
  `.simpleDrawerPane[data-drawer="deuda"]:has(input[name="simpleDebtKind"][value="loan"]:checked) .debtSimpleBalanceField{display:none}`,
  `.simpleDrawerPane[data-drawer="deuda"]:has(input[name="simpleDebtKind"][value="credit_card"]:checked) .debtCurrentStateBlock{display:none}`,
].join("\n");

/** The selector a pane's props imply: `.class[attr="value"]`. */
function selectorOf(props: Record<string, string>): string {
  const { className, ...attrs } = props;
  const filters = Object.entries(attrs)
    .map(([attr, value]) => `[${attr}="${value}"]`)
    .join("");
  return `.${className}${filters}`;
}

describe("altaRevealCss", () => {
  test("reproduces the stylesheet the page used to inline, rule for rule", () => {
    expect(altaRevealCss()).toBe(EXPECTED_CSS);
  });

  test("every drawer's rule targets the pane props its own module hands out", () => {
    const css = altaRevealCss();

    for (const drawer of DRAWERS) {
      const pane = selectorOf(drawerPaneProps(drawer.id) as Record<string, string>);
      expect(css, `drawer ${drawer.id} has no rule revealing ${pane}`).toContain(
        `:has(input[name="${DRAWER_FIELD}"][value="${drawer.id}"]:checked) ${pane}{`,
      );
    }
  });

  test("every investment group and every capture mode is revealed the same way", () => {
    const css = altaRevealCss();

    for (const group of INVESTMENT_GROUPS) {
      const groupPane = selectorOf(
        groupPaneProps(group.instrument) as Record<string, string>,
      );
      expect(css).toContain(
        `:has(input[name="${GROUP_FIELD}"][value="${group.instrument}"]:checked) ${groupPane}{`,
      );

      for (const mode of INVESTMENT_MODES) {
        const modePane = selectorOf(modePaneProps(mode.id) as Record<string, string>);
        expect(
          css,
          `${group.instrument}/${mode.id} has no rule revealing ${modePane}`,
        ).toContain(
          `${groupPane}:has(input[name="${modeField(group.instrument)}"][value="${mode.id}"]:checked) ${modePane}{display:${mode.display}}`,
        );
      }
    }
  });

  test("every debt kind hides exactly the block it declares", () => {
    const css = altaRevealCss();

    for (const kind of DEBT_KINDS) {
      const block = selectorOf(debtBlockProps(kind.hides));
      expect(css).toContain(
        `:has(input[name="${DEBT_KIND_FIELD}"][value="${kind.id}"]:checked) ${block}{display:none}`,
      );
    }
  });

  test("the two placeholders are hidden by the class their props carry", () => {
    const css = altaRevealCss();

    // The group placeholder also carries `simpleHint`; only the first class is
    // the disclosure's business, so the rule targets that one.
    expect(css).toContain(`.${DRAWER_EMPTY_PROPS.className}{display:none}`);
    expect(css).toContain(`.${GROUP_EMPTY_PROPS.className.split(" ")[0]}{display:none}`);
  });

  test("no rule is emitted for a pane nobody renders, and none is missing", () => {
    const rules = altaRevealCss().split("\n");
    // 1 drawer placeholder + 5 drawers + 1 group placeholder
    // + 3 groups × (1 reveal + 3 modes) + 3 debt kinds.
    expect(rules).toHaveLength(1 + 5 + 1 + 3 * 4 + 3);
    expect(new Set(rules).size).toBe(rules.length);
  });
});

describe("the capture mode's default is a negative list (#1541)", () => {
  test("exactly one mode is the default", () => {
    expect(INVESTMENT_MODES.filter((mode) => mode.isDefault)).toHaveLength(1);
  });

  test("anything the round-trip did not bring back reopens the default", () => {
    expect(isNonDefaultInvestmentMode(undefined)).toBe(false);
    expect(isNonDefaultInvestmentMode("")).toBe(false);
    expect(isNonDefaultInvestmentMode("saldo")).toBe(false);
    // A value from a mode that does not exist yet must not leave the group with
    // no radio checked — which would be a form that submits nothing.
    expect(isNonDefaultInvestmentMode("a-future-mode")).toBe(false);
    expect(isNonDefaultInvestmentMode("import")).toBe(true);
    expect(isNonDefaultInvestmentMode("traspaso")).toBe(true);
  });
});
