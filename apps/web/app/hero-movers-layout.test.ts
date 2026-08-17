/**
 * Layout guardian for the hero movers («Qué lo movió»).
 *
 * A holding name is long ("Schroder International Selection Fund Global Gold A
 * Acc EUR") and the hero margin is narrow (300px), so the name MUST be the part
 * that gives way. Two CSS traps broke that and let a movers row escape the
 * margin and paint on top of the neighbouring «Liquidez» panel:
 *
 *   1. a `1fr` grid track is `minmax(auto, 1fr)`, and that `auto` floor grows to
 *      the column's min-content — the nowrap name's full width — so the track
 *      (and every row in it) overflowed the margin instead of truncating.
 *   2. `flex-wrap: wrap` on the margin row pushed the € figure onto a second
 *      line, left-aligned, breaking the annotation's «name ⋯ figure» reading.
 *
 * Measured in a Chromium rig: before the fix each row was 416px wide inside a
 * 275px column, 141px of it over the panel to its right.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "globals.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

type CssRule = { declarations: string; selector: string };

/**
 * Flat rules only — the inner `selector { ... }` of an `@media` block matches on
 * its own, which is what we want: the responsive overrides get checked too.
 */
function rules(): CssRule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    declarations: match[2] ?? "",
    selector: (match[1] ?? "").trim().replace(/\s+/g, " "),
  }));
}

function moversRules(): CssRule[] {
  return rules().filter((rule) => /\bmovers/i.test(rule.selector));
}

function declaration(rule: CssRule, property: string): string | undefined {
  const match = rule.declarations.match(
    new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`),
  );
  return match?.[1]?.trim().replace(/\s+/g, " ");
}

function ruleFor(selector: string): CssRule {
  const found = moversRules().find((rule) => rule.selector === selector);
  if (!found) throw new Error(`rule not found: ${selector}`);
  return found;
}

describe("hero movers layout", () => {
  test("no movers grid track can grow past its container", () => {
    const unbounded = moversRules()
      .map((rule) => ({
        selector: rule.selector,
        value: declaration(rule, "grid-template-columns"),
      }))
      .filter(({ value }) => value !== undefined)
      // A bare `1fr` (or `minmax(auto, …)`) floors the track at min-content; a
      // `minmax(0, 1fr)` track is the fix, and the `auto` track holding the €
      // figure is fine — that content stays short.
      .filter(({ value }) =>
        /\d+(?:\.\d+)?fr\b|minmax\(\s*auto/.test(
          value!.replace(/minmax\(\s*(?!auto)[^,]+,[^)]*\)/g, " "),
        ),
      );

    expect(unbounded).toEqual([]);
  });

  test("the margin row keeps the € figure on the name's line", () => {
    expect(declaration(ruleFor(".heroMargin .moversHolding"), "flex-wrap")).toBe(
      "nowrap",
    );
  });

  test("the holding name is the element that gives way", () => {
    const name = ruleFor(".moversHoldingName");

    expect(declaration(name, "min-width")).toBe("0");
    expect(declaration(name, "overflow")).toBe("hidden");
    expect(declaration(name, "text-overflow")).toBe("ellipsis");
    expect(declaration(name, "white-space")).toBe("nowrap");
    // Shrinkable in the margin's flex row (`flex: <grow> <shrink> <basis>`).
    expect(declaration(ruleFor(".heroMargin .moversHoldingLabel"), "flex")).toBe(
      "0 1 auto",
    );
    expect(declaration(ruleFor(".moversHoldingLabel"), "min-width")).toBe("0");
  });

  test("neither the € figure nor the chips shrink with the name", () => {
    expect(declaration(ruleFor(".heroMargin .moversHoldingVal"), "flex")).toBe(
      "0 0 auto",
    );
    expect(declaration(ruleFor(".moversHoldingLabel .moversTag"), "flex")).toBe(
      "0 0 auto",
    );
  });
});
