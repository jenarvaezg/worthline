import type { FireScopeConfig, ScopeFireResult } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  coastFormulaLine,
  coastProgressPercent,
  fireFundedView,
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

describe("coastFormulaLine (#1426)", () => {
  const config: FireScopeConfig = {
    currentAge: 63,
    monthlySpendingMinor: 200_000,
    safeWithdrawalRate: 0.035,
    targetRetirementAge: 67,
  };

  /** Only the fields the coast line reads. */
  function coastResult(rate: number): ScopeFireResult {
    return {
      coastFireRequired: { amountMinor: 597_477_00, currency: "EUR" },
      context: { realReturnUsed: rate },
      fireNumber: { amountMinor: 685_714_29, currency: "EUR" },
    } as ScopeFireResult;
  }

  test("closes the chain: the requirement says what it was discounted from, and how", () => {
    expect(coastFormulaLine({ config, formatMoney, result: coastResult(0.035) })).toBe(
      "tu número FIRE descontado 4 años al 3,5 %: 685.714 € → 597.477 €",
    );
  });

  test("says one year in the singular", () => {
    expect(
      coastFormulaLine({
        config: { ...config, targetRetirementAge: 64 },
        formatMoney,
        result: coastResult(0.035),
      }),
    ).toContain("descontado 1 año al");
  });

  test("is null when there is no coast requirement or no age to count from", () => {
    expect(
      coastFormulaLine({ config, formatMoney, result: {} as ScopeFireResult }),
    ).toBeNull();
    const { currentAge: _derived, ...ageless } = config;
    expect(
      coastFormulaLine({ config: ageless, formatMoney, result: coastResult(0.035) }),
    ).toBeNull();
  });
});
