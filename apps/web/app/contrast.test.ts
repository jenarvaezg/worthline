import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Accessibility floor (#38): structural tokens must keep WCAG contrast against
 * both page backgrounds. Parses globals.css so a token change that regresses
 * contrast fails here instead of shipping.
 */

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "globals.css"),
  "utf8",
);

function token(name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));

  if (!match) {
    throw new Error(`Token ${name} not found in globals.css`);
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

const backgrounds = [token("--paper"), token("--paper-strong")];

describe("contrast tokens (WCAG)", () => {
  test("--line meets ≥3:1 non-text contrast on both papers", () => {
    for (const background of backgrounds) {
      expect(contrastRatio(token("--line"), background)).toBeGreaterThanOrEqual(3);
    }
  });

  test("--line-strong meets ≥3:1 non-text contrast on both papers", () => {
    for (const background of backgrounds) {
      expect(contrastRatio(token("--line-strong"), background)).toBeGreaterThanOrEqual(3);
    }
  });

  test("--muted label text meets ≥4.5:1 on both papers", () => {
    for (const background of backgrounds) {
      expect(contrastRatio(token("--muted"), background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("--line-strong stays darker than --line to preserve hierarchy", () => {
    expect(luminance(token("--line-strong"))).toBeLessThan(luminance(token("--line")));
  });
});
