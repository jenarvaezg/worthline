/**
 * E2E journey-index guardian (#1706): the numeric prefix of a spec file is the
 * suite's index, and an index only orders while it is unique.
 *
 * Playwright runs the suite serially in path order (see `playwright.config.ts`),
 * so `31-` is not decoration — it is the position a journey runs at and the name
 * every other journey, comment and CI log refers to it by. Two files sharing a
 * prefix (`31-add-investment-saldo` and `31-binance-connected-source` did, as did
 * two `40-`s) still run, which is exactly why nothing caught it: the failure is not
 * a red test but a "journey 31" that means two different things.
 *
 * The prefix is compared as written, not as a number. `0-warm-routes` and
 * `00-route-migration` deliberately coexist: `-` sorts before `0`, so `0-` runs
 * first, and that ordering is the whole reason journey 0 has a single digit.
 *
 * Lives in the `@worthline/tests` workspace for the same reason
 * `e2e-page-scope-guardian` does — it reads `e2e/` through the web app's shared
 * guardian walk, and this is the workspace whose aliases reach both.
 */
import { dirname, join } from "node:path";
import { walkSourceFiles } from "@web/guardian-walk";
import { describe, expect, test } from "vitest";

/** The suite lives at the repo root, one level above `tests/`. */
const E2E_DIR = join(import.meta.dirname, "../e2e");

/** `"31"` for `31-add-investment-saldo.spec.ts`; `null` for an unnumbered spec. */
export function journeyIndex(fileName: string): string | null {
  const match = fileName.match(/(?:^|\/)(\d+)-[^/]*\.spec\.ts$/);
  return match?.[1] ?? null;
}

/**
 * Every index more than one spec claims, with the specs that share it. Specs
 * compete for a position only within their own directory, since Playwright orders
 * by full path.
 */
export function duplicateJourneyIndexes(
  fileNames: readonly string[],
): Array<{ index: string; specs: string[] }> {
  const claims = new Map<string, { index: string; specs: string[] }>();
  for (const fileName of fileNames) {
    const index = journeyIndex(fileName);
    if (index === null) continue;
    // Keyed by directory AND index; the index is kept as data so no caller has to
    // decode it back out of the key.
    const key = `${dirname(fileName)}:${index}`;
    const claim = claims.get(key) ?? { index, specs: [] };
    claims.set(key, { index, specs: [...claim.specs, fileName] });
  }
  return [...claims.values()].filter(({ specs }) => specs.length > 1);
}

/** Every journey in the suite, relative to `e2e/`. */
function specFileNames(): string[] {
  return walkSourceFiles(E2E_DIR)
    .filter((filePath) => filePath.endsWith(".spec.ts"))
    .map((filePath) => filePath.slice(E2E_DIR.length + 1));
}

describe("e2e journey-index guardian (#1706)", () => {
  test("the suite has numbered specs to check (the walk itself is not silently empty)", () => {
    const numbered = specFileNames().filter(
      (fileName) => journeyIndex(fileName) !== null,
    );
    expect(numbered.length).toBeGreaterThan(40);
  });

  test("no two journeys share an index", () => {
    const offenders = duplicateJourneyIndexes(specFileNames()).map(
      ({ index, specs }) => `${index}: ${specs.join(", ")}`,
    );

    expect(
      offenders,
      "the numeric prefix is the suite's index and the name a journey is referred " +
        "to by; renumber one of each pair to the next free slot (#1706)",
    ).toEqual([]);
  });

  describe("the scan itself", () => {
    test("reads the index off a numbered spec and nothing off an unnumbered one", () => {
      expect(journeyIndex("31-add-investment-saldo.spec.ts")).toBe("31");
      expect(journeyIndex("0-warm-routes.spec.ts")).toBe("0");
      expect(journeyIndex("demo.spec.ts")).toBeNull();
      expect(journeyIndex("route-migration-auth.spec.ts")).toBeNull();
      // A helper that is not a spec never claims a slot, whatever it is called.
      expect(journeyIndex("31-fixtures.ts")).toBeNull();
    });

    test("names the shared index and every spec claiming it", () => {
      expect(
        duplicateJourneyIndexes([
          "31-add-investment-saldo.spec.ts",
          "31-binance-connected-source.spec.ts",
          "32-price-refresh-meta.spec.ts",
        ]),
      ).toEqual([
        {
          index: "31",
          specs: [
            "31-add-investment-saldo.spec.ts",
            "31-binance-connected-source.spec.ts",
          ],
        },
      ]);
    });

    test("compares the prefix as written: `0` and `00` are two positions", () => {
      expect(
        duplicateJourneyIndexes(["0-warm-routes.spec.ts", "00-route-migration.spec.ts"]),
      ).toEqual([]);
    });

    test("specs in different directories do not compete for a slot", () => {
      expect(
        duplicateJourneyIndexes(["01-first-run-solo.spec.ts", "smoke/01-boot.spec.ts"]),
      ).toEqual([]);
    });
  });
});
