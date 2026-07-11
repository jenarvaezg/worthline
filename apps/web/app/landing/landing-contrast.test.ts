import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * WCAG floor for the cover register (#951): the landing defines its own
 * cover tokens (contract #828, local to the landing until «Libro mayor»
 * consolidates them), so it carries its own contrast tripwire — mirror of
 * app/contrast.test.ts for globals.css.
 */

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "landing.module.css"),
  "utf8",
);

function token(name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));

  if (!match) {
    throw new Error(`Token ${name} not found in landing.module.css`);
  }

  return match[1]!;
}

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => {
    const channel = Number.parseInt(part, 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );

  return (high! + 0.05) / (low! + 0.05);
}

describe("landing cover tokens (WCAG)", () => {
  test("cover ink and muted read as text on the cover (≥4.5:1)", () => {
    for (const name of ["--cover-ink", "--cover-muted"]) {
      expect(contrastRatio(token(name), token("--cover"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("gilt reads as small text on the cover (≥4.5:1)", () => {
    expect(contrastRatio(token("--gilt"), token("--cover"))).toBeGreaterThanOrEqual(4.5);
  });

  test("page ink and muted read on both papers (≥4.5:1)", () => {
    for (const background of ["--paper", "--panel"]) {
      for (const name of ["--ink", "--muted"]) {
        expect(contrastRatio(token(name), token(background))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
