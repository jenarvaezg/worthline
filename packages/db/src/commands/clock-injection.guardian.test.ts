/**
 * Clock-injection guardian (#1598, ADR 0024): no command seam derives the day it
 * writes against. Every dated-fact command takes `today` as a required argument,
 * so the caller and the ripple it triggers are always on ONE calendar; the store's
 * injected clock is read once, at construction, for the writes with no caller to
 * ask (the post-migrate re-ripples).
 *
 * The failure this pins is silent: a `today?: string` beside a local
 * `defaultToday()` makes a command that reads the wall clock look identical to one
 * that was told the day. A spec then passes a fixed day, the seam under it reads
 * the real calendar, and the two disagree — every time CI runs across midnight, or
 * whenever a ripple's cut-off falls a day away from the fact that caused it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const commandsDirectory = import.meta.dirname;

/** Every command module (implementations + executors), tests excluded. */
function commandModules(): string[] {
  return readdirSync(commandsDirectory)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();
}

function source(module: string): string {
  return readFileSync(join(commandsDirectory, module), "utf8");
}

describe("command seams take the day, never derive it (#1598)", () => {
  test.each(commandModules())("%s reads no wall clock", (module) => {
    // `new Date(someIsoString)` is arithmetic on a stated date and stays allowed;
    // `new Date()` with no argument is the wall clock this ticket removed.
    expect(source(module)).not.toMatch(/new Date\(\s*\)/);
  });

  test.each(commandModules())("%s declares no optional `today`", (module) => {
    expect(source(module)).not.toMatch(/\btoday\?:/);
  });
});
