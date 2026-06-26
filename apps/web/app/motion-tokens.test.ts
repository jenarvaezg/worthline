import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "globals.css"),
  "utf8",
);
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

function rootBody(): string {
  const open = css.indexOf(":root {");
  if (open === -1) throw new Error(":root block not found");
  const close = css.indexOf("\n}", open);
  return css.slice(open, close);
}

function motionDeclarations(): string[] {
  return [
    ...cssWithoutComments.matchAll(
      new RegExp(`(?:transition|animation)[^:]*:\\s*([^;]+);`, "g"),
    ),
  ].map((match) => match[1] ?? "");
}

describe("motion tokens (#637)", () => {
  test("defines shared motion tokens in the design-system root", () => {
    const root = rootBody();

    for (const token of [
      "--dur-fast",
      "--dur-base",
      "--dur-spin",
      "--dur-shimmer",
      "--ease-out",
      "--ease-in",
    ]) {
      expect(root).toContain(token);
    }
  });

  test("transition and animation declarations use motion tokens instead of timing literals", () => {
    const timedDeclarations = motionDeclarations().filter((declaration) =>
      /\b(?:120ms|140ms|150ms|200ms|0\.12s|0\.15s|0\.6s|1\.4s)\b/.test(declaration),
    );

    expect(timedDeclarations).toEqual([]);
  });
});
