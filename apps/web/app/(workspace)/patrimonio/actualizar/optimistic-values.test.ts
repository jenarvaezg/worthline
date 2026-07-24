import { describe, expect, test } from "vitest";

import { applyValueEdits, parseValueEdits } from "./optimistic-values";

/**
 * The pure optimistic-merge for the "Puesta al día" batch value pass (#521, S5 of
 * #485, interaction-patterns §4/§7). When the form is submitted, the island shows
 * each row's just-typed value as its new "Actual:" amount BEFORE
 * `batchValueUpdateAction` resolves, then the redirect to /patrimonio settles it.
 * Kept pure (no React) so it unit-tests in the node env while the form stays a thin
 * `useOptimistic` shell — the `composition-chart-hover` / `view-state` split.
 */

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    fd.set(key, value);
  }
  return fd;
}

describe("applyValueEdits", () => {
  test("overrides an edited row's value, leaving the rest at their base", () => {
    const base = new Map([
      ["a1", 5000_00],
      ["a2", 3000_00],
    ]);

    const next = applyValueEdits(base, [{ id: "a1", valueMinor: 8000_00 }]);

    expect(next.get("a1")).toBe(8000_00);
    expect(next.get("a2")).toBe(3000_00);
  });

  test("never mutates the base map", () => {
    const base = new Map([["a1", 5000_00]]);

    applyValueEdits(base, [{ id: "a1", valueMinor: 8000_00 }]);

    expect(base.get("a1")).toBe(5000_00);
  });
});

describe("parseValueEdits", () => {
  test("reads the val_<id> fields as es-ES money into minor-unit edits", () => {
    // The form feeds values the way `formatMoneyInput` writes them: comma decimals,
    // no thousands dots ("8000", "4000,50") — the same strings the action parses.
    const edits = parseValueEdits(form({ val_a1: "8000", val_a2: "4000,50" }), [
      "a1",
      "a2",
    ]);

    expect(edits).toEqual([
      { id: "a1", valueMinor: 8000_00 },
      { id: "a2", valueMinor: 4000_50 },
    ]);
  });

  test("drops a blank or unparseable field, keeping that row at its server value", () => {
    const edits = parseValueEdits(form({ val_a1: "8000", val_a2: "", val_a3: "abc" }), [
      "a1",
      "a2",
      "a3",
    ]);

    expect(edits).toEqual([{ id: "a1", valueMinor: 8000_00 }]);
  });
});
