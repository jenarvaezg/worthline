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

  test.each(adrFiles)("%s is named NNNN-kebab-case-title.md", (name) => {
    expect(name).toMatch(ADR_FILENAME);
  });

  test("no two ADRs share a number", () => {
    const byNumber = new Map<string, string[]>();
    for (const name of adrFiles) {
      const number = name.slice(0, 4);
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }

    const collisions = [...byNumber.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([number, names]) => `${number}: ${names.join(", ")}`);

    expect(collisions).toEqual([]);
  });
});
