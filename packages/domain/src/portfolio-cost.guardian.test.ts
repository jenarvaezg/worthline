/**
 * The TER never enters a return (#1717).
 *
 * A fund's net asset value is already net of its ongoing charges, so a
 * rentabilidad that subtracted the TER would charge it twice. The TER is read in
 * one place — the portfolio-cost lens, «never a figure the math reads» — and this
 * guardian keeps every returns module from reaching it: none may import the lens,
 * directly or through any module it imports, and none may read a `ter` field.
 *
 * Returns modules are found by name, so a new `*return*.ts` is guarded the day it
 * lands rather than when someone remembers to add it to a list.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const srcDirectory = import.meta.dirname;
const COST_LENS = "portfolio-cost.ts";

function isProductionModule(entry: string): boolean {
  return entry.endsWith(".ts") && !entry.endsWith(".test.ts");
}

/** Every returns module of the domain: holding returns, per class, FIRE return. */
function returnsModules(): string[] {
  return readdirSync(srcDirectory)
    .filter((entry) => isProductionModule(entry) && /return/.test(entry))
    .sort();
}

function source(module: string): string {
  return readFileSync(join(srcDirectory, module), "utf8");
}

const RELATIVE_SPECIFIER = /(?:from|import)\s*["'](\.\/[^"']+)["']/g;

/** The domain modules `module` imports, directly or transitively. */
function importClosure(module: string): Set<string> {
  const seen = new Set<string>();
  const pending = [module];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const [, specifier] of source(current).matchAll(RELATIVE_SPECIFIER)) {
      const resolved = resolveModule(specifier as string);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return seen;
}

function resolveModule(specifier: string): string | null {
  const bare = specifier.slice(2).replace(/\.(js|ts)$/, "");
  for (const candidate of [`${bare}.ts`, `${bare}/index.ts`]) {
    if (existsSync(join(srcDirectory, candidate))) {
      return candidate;
    }
  }
  return null;
}

describe("the TER never enters a return (#1717)", () => {
  test("the guard sees the returns modules and follows imports", () => {
    // Without these the checks below would pass vacuously over nothing.
    expect(returnsModules()).toEqual(
      expect.arrayContaining(["returns.ts", "returns-by-class.ts", "fire-return.ts"]),
    );
    expect(importClosure(COST_LENS)).toContain("exposure-lookthrough.ts");
  });

  test.each(returnsModules())("%s never reaches the portfolio-cost lens", (module) => {
    expect(importClosure(module)).not.toContain(COST_LENS);
  });

  test.each(returnsModules())("%s reads no TER", (module) => {
    expect(source(module)).not.toMatch(/\bter\b/);
  });
});
