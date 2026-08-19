import type { ScopeFireResult } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  coastProgressPercent,
  fireFundedView,
  formatProgressPercent,
} from "./fire-funding-view";

const formatMoney = (amountMinor: number) =>
  `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(
    Math.round(amountMinor / 100),
  )} €`;

/** Only the fields the funding view reads; the rest of the result is irrelevant here. */
function resultOf(eligibleMinor: number, fireNumberMinor: number): ScopeFireResult {
  return {
    eligibleAssets: { amountMinor: eligibleMinor, currency: "EUR" },
    fireNumber: { amountMinor: fireNumberMinor, currency: "EUR" },
    percentFunded: (eligibleMinor / fireNumberMinor) * 100,
  } as ScopeFireResult;
}

describe("fireFundedView (#1426)", () => {
  test("carries the fraction the percentage came from", () => {
    const view = fireFundedView({
      formatMoney,
      result: resultOf(469_671_00, 685_714_29),
    });

    expect(view).toEqual({
      fraction: "469.671 € de 685.714 €",
      percent: "68,5 %",
    });
  });
});

describe("coastProgressPercent (#1426)", () => {
  test("measures the reader's progress toward Coast, not the tick's position", () => {
    // 469.671 € against a 577.000 € coast requirement — «llevo el ~81 % de Coast».
    expect(coastProgressPercent(469_671_00, 577_000_00)).toBeCloseTo(81.4, 1);
  });

  test("can pass 100 % once Coast is behind you", () => {
    expect(coastProgressPercent(600_000_00, 500_000_00)).toBeCloseTo(120, 10);
  });

  test("is null with no coast requirement to measure against", () => {
    expect(coastProgressPercent(100_000_00, null)).toBeNull();
    expect(coastProgressPercent(100_000_00, undefined)).toBeNull();
    expect(coastProgressPercent(100_000_00, 0)).toBeNull();
  });
});

describe("formatProgressPercent", () => {
  test("keeps one decimal in es-ES", () => {
    expect(formatProgressPercent(68.45)).toBe("68,5 %");
    expect(formatProgressPercent(100)).toBe("100,0 %");
  });
});
