import { describe, expect, test } from "vitest";

import { heroSheetData } from "./build-hero-sheet";

/**
 * Arithmetic reconciliation of the SSG hero sheet (#952, PRD #877). The sheet is
 * real demo data resolved at build time, so CI must prove it cuadra by the same
 * invariant the engine enforces at capture: bruto − deuda = neto. Mirrors the
 * style of `snapshot-holdings.test.ts` reconciliation block.
 */

describe("hero sheet SSG data (#952)", () => {
  test("the sheet reconciles: bruto − deuda = neto", () => {
    expect(heroSheetData.grossMinor - heroSheetData.debtsMinor).toBe(
      heroSheetData.netMinor,
    );
  });

  test("the composition breakdown independently reconciles to grossMinor", () => {
    // Unlike the bruto−deuda check above (both fields come off the same frozen
    // snapshot), this sums the frozen per-holding rows bucketed by tier and
    // compares against the snapshot's separately-captured grossAssets — the
    // same kind of cross-check as `assertSnapshotHoldingsReconcile`.
    const sum = heroSheetData.composition.reduce(
      (total, seg) => total + seg.amountMinor,
      0,
    );
    expect(sum).toBe(heroSheetData.grossMinor);
  });

  test("carries the last 12 monthly closes for the sparkline", () => {
    expect(heroSheetData.closes).toHaveLength(12);
    expect(heroSheetData.sparkline.points.trim().split(/\s+/)).toHaveLength(12);
  });

  test("composition legend percentages sum to ~100 despite independent rounding", () => {
    const sum = heroSheetData.composition.reduce((total, seg) => total + seg.pct, 0);
    // Each of up to 5 tiers can round up to 0.5pp away from its true share.
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(heroSheetData.composition.length);
    // The housing rung is the striped band (vivienda rayada).
    expect(heroSheetData.composition.some((seg) => seg.housing)).toBe(true);
  });

  test("the debt row carries the debe line, negative-signed", () => {
    const debit = heroSheetData.rows.find((row) => row.debit);
    expect(debit, "no debit row").toBeDefined();
    expect(debit!.value).toContain("-");
  });
});
