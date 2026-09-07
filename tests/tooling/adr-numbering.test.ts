import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * ADR numbers are addresses (#1704). This repo cites decisions by number from
 * code comments, tests, `CONTEXT.md` and other ADRs — «ver ADR 0096» has to
 * resolve to exactly one file. Four ADRs once shared 0096 and two shared 0071,
 * which made every one of those citations ambiguous. This guard fails the gate
 * the moment a new ADR reuses a number already taken.
 *
 * Both assertions collect offenders and compare against `[]` so the report
 * names what is wrong instead of growing one case per ADR on disk.
 */
const ADR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../docs/adr");

/** `NNNN-kebab-case-title.md` — the number is the address, the slug the hint. */
const ADR_FILENAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const adrFiles = readdirSync(ADR_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

describe("ADR numbering (#1704)", () => {
  test("docs/adr is not empty", () => {
    expect(adrFiles.length).toBeGreaterThan(0);
  });

  test("every ADR is named NNNN-kebab-case-title.md", () => {
    const misnamed = adrFiles.filter((name) => !ADR_FILENAME.test(name));

    expect(misnamed).toEqual([]);
  });

  test("no two ADRs share a number", () => {
    const byNumber = new Map<string, string[]>();
    for (const name of adrFiles) {
      // The filename regex is the single source of what the number is; a file
      // that does not match is already reported by the test above.
      const number = ADR_FILENAME.exec(name)?.[1];
      if (number === undefined) continue;

      const taken = byNumber.get(number);
      if (taken === undefined) byNumber.set(number, [name]);
      else taken.push(name);
    }

    const collisions = [...byNumber.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([number, names]) => `${number}: ${names.join(", ")}`);

    expect(collisions).toEqual([]);
  });
});
