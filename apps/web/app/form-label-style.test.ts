import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Design-system contract (#603, design-system.md §2): form FIELD labels render
 * in sentence case at a legible size — they are NOT the "labels pequeños"
 * treatment (0.7–0.78rem, uppercase, weight 800), which §2 reserves for stats,
 * table headers and `h3`. Parsing the rule here means a regression to the old
 * uppercase/tiny treatment fails in CI instead of shipping.
 */

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "globals.css"),
  "utf8",
);

/** Body of the first CSS rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`Selector ${selector} not found in globals.css`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("form field label style (#603)", () => {
  const body = ruleBody(".stackForm label");

  test("the field-label rule covers both stackForm and ownershipGrid", () => {
    // One rule fixes every form; guard the shared selector list stays intact.
    expect(css).toContain(".ownershipGrid label");
    expect(css.indexOf(".ownershipGrid label")).toBeLessThan(
      css.indexOf("{", css.indexOf(".stackForm label")),
    );
  });

  test("field labels are sentence case (no uppercase)", () => {
    expect(body).not.toMatch(/text-transform:\s*uppercase/);
  });

  test("field labels are not the tiny 0.74rem treatment", () => {
    expect(body).not.toMatch(/font-size:\s*0\.74rem/);
  });

  test("field labels are not the heavy 800 weight", () => {
    expect(body).not.toMatch(/font-weight:\s*800/);
  });
});
