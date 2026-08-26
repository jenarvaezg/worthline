/**
 * Facade guardian (#1587, ADR 0087): `control-plane.ts` composes the ports and
 * owns nothing else. The file that every fleet-wide concern used to grow into
 * must not grow SQL, tables or row mappers again — the next billing field, job
 * column or meter belongs in its port's module.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const portsDirectory = import.meta.dirname;
const facadePath = join(portsDirectory, "../control-plane.ts");
const facade = readFileSync(facadePath, "utf8");

/** Everything that means "this file talks to the database itself". */
const IMPLEMENTATION_MARKERS = [
  /\bsql:\s/,
  /\bCREATE TABLE\b/,
  /\bCREATE (UNIQUE )?INDEX\b/,
  /\bSELECT\b/,
  /\bINSERT INTO\b/,
  /\bUPDATE\b\s+\w/,
  /\bDELETE FROM\b/,
  /\brows\[0\]/,
] as const;

/** The port modules: every non-test module exporting a `create…` factory. */
function portModules(): string[] {
  return readdirSync(portsDirectory)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .filter((entry) =>
      /export function create\w+\(/.test(
        readFileSync(join(portsDirectory, entry), "utf8"),
      ),
    )
    .sort();
}

describe("control-plane facade · composes only (#1587)", () => {
  test.each(IMPLEMENTATION_MARKERS)("no %s in control-plane.ts", (marker) => {
    expect(facade).not.toMatch(marker);
  });

  test("every port module is composed by the facade", () => {
    const modules = portModules();
    expect(modules.length).toBeGreaterThan(0);
    for (const entry of modules) {
      const stem = entry.replace(/\.ts$/, "");
      expect(facade, `${stem} is a port module nobody composes`).toContain(
        `"./control-plane/${stem}"`,
      );
    }
  });
});
