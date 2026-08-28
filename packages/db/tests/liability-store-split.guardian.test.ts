/**
 * The seam of #1604: the liability row and each family of dated debt fact — the
 * amortization plan, its rate revisions, its early repayments, the balance
 * re-baselines, the anchors — are separate reasons to change, so they are
 * separate modules. This pins the DIRECTION of that seam by reading each
 * module's imports, which is where a re-entangling actually shows up: a fact
 * family that starts writing another family's table, or a curve change that
 * lands back in the alta del pasivo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const sourceDirectory = join(import.meta.dirname, "../src");

function sourceOf(file: string): string {
  return readFileSync(join(sourceDirectory, file), "utf8");
}

/** Every module specifier the file imports from. */
function importsOf(file: string): string[] {
  return [...sourceOf(file).matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";$/gm)].map(
    (match) => match[1]!,
  );
}

/** The drizzle tables the file pulls out of `./schema`, if any. */
function tablesOf(file: string): string[] {
  const block = sourceOf(file).match(/import\s+\{([^}]*)\}\s+from\s+"\.\/schema";/);
  if (!block) return [];
  return block[1]!
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

const RECORD = "liability-store.ts";
const BALANCE_READS = "liability-balance-reads.ts";
/** One module per family of dated fact, with the table that family owns. */
const FACT_FAMILIES = {
  "liability-amortization-plan-store.ts": ["amortizationPlans"],
  "liability-balance-anchor-store.ts": ["liabilityBalanceAnchors"],
  "liability-balance-rebaseline-store.ts": ["liabilityBalanceRebaselines"],
  "liability-early-repayment-store.ts": ["earlyRepayments"],
  "liability-rate-revision-store.ts": ["interestRateRevisions"],
} as const;

type FactFamily = keyof typeof FACT_FAMILIES;

const PLAN = "liability-amortization-plan-store.ts";
/** The two families whose rows carry a `planId`, and so may resolve the plan. */
const HANG_OFF_A_PLAN: readonly FactFamily[] = [
  "liability-early-repayment-store.ts",
  "liability-rate-revision-store.ts",
];

describe("liability store · one module per family of dated fact (#1604)", () => {
  test("the alta del pasivo reaches for no curve at all", () => {
    const specifiers = importsOf(RECORD);

    for (const family of Object.keys(FACT_FAMILIES)) {
      expect(specifiers).not.toContain(`./${family.replace(/\.ts$/, "")}`);
    }
    expect(specifiers).not.toContain("./liability-balance-reads");
    // Its tables are the liability row and its ownership — not one table of a
    // dated fact, so «un cambio de curva no obliga a revisar el CRUD».
    expect(tablesOf(RECORD)).toEqual(["liabilities", "liabilityOwnerships"]);
  });

  test("each family writes its own table and nobody else's", () => {
    for (const [family, tables] of Object.entries(FACT_FAMILIES)) {
      expect(tablesOf(family), family).toEqual([...tables]);
    }
  });

  test("families never read a sibling; only the composed read does", () => {
    for (const family of Object.keys(FACT_FAMILIES)) {
      const specifiers = importsOf(family);
      // The row, and the read that folds every family into a figure, are both
      // downstream of a fact family — the arrow never points back.
      expect(specifiers, family).not.toContain("./liability-store");
      expect(specifiers, family).not.toContain("./liability-balance-reads");

      const siblings = Object.keys(FACT_FAMILIES)
        .filter((other) => other !== family)
        // The ONLY sibling read allowed, and only to the two families that hang
        // off a `planId`: resolving the plan a revision or a repayment belongs to
        // is theirs to do. A re-baseline or an anchor answers for the whole
        // balance and never meets a plan — if one starts reading it, say so.
        .filter(
          (other) => !(other === PLAN && HANG_OFF_A_PLAN.includes(family as FactFamily)),
        )
        .map((other) => `./${other.replace(/\.ts$/, "")}`);
      for (const sibling of siblings) {
        expect(specifiers, family).not.toContain(sibling);
      }
    }
  });

  test("the figure on a date is composed in exactly one place", () => {
    const specifiers = importsOf(BALANCE_READS);

    for (const family of Object.keys(FACT_FAMILIES)) {
      expect(specifiers).toContain(`./${family.replace(/\.ts$/, "")}`);
    }
    // It reads the liability row for the current balance, the model and the
    // cadence — and not one fact table directly: each family answers for its own.
    expect(tablesOf(BALANCE_READS)).toEqual(["liabilities"]);
  });
});
