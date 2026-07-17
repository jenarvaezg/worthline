/**
 * FIRE rate resolution + context (#1026, was the N3 anti-drift suite, #515).
 *
 * The 364-line propagation suite this replaces existed to police a convention:
 * that every consumer (coast, projectFire, fireLevels, goalFireDelay) remembered
 * to thread `realReturnUsed` instead of reaching for `config.expectedRealReturn`.
 * That invariant is now carried by a TYPE — `FireContext` bundles the resolved
 * rate with the eligible totals, and consumers take the context, so there is no
 * loose rate a caller can forget. What's left to test is just the resolution
 * itself and the one explicit override path (`withRate`).
 */
import { describe, expect, it } from "vitest";
import { calculateFireForScope, projectFireFromContext, withRate } from "./fire";
import { TIER_REAL_RETURN_DEFAULTS } from "./fire-return";
import type { ManualAsset, Workspace } from "./index";

const workspace: Workspace = {
  baseCurrency: "EUR",
  mode: "household",
  members: [{ id: "alice", name: "Alice" }],
  groups: [],
};

function makeAsset(
  id: string,
  amountMinor: number,
  liquidityTier: ManualAsset["liquidityTier"] = "market",
): ManualAsset {
  return {
    id,
    name: id,
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier,
    ownership: [{ memberId: "alice", shareBps: 10_000 }],
    isPrimaryResidence: false,
  };
}

const BASE_CONFIG = {
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.04,
} as const;

describe("calculateFireForScope resolves the rate into the context", () => {
  it("override set → context.realReturnUsed is the override; effective still computed", () => {
    const { context } = calculateFireForScope(
      { ...BASE_CONFIG, expectedRealReturn: 0.07 },
      [makeAsset("stocks", 1_000_000, "market")],
      [],
      workspace,
      "alice",
    );

    expect(context.realReturnUsed).toBeCloseTo(0.07, 10);
    expect(context.effectiveRealReturn).toBeCloseTo(TIER_REAL_RETURN_DEFAULTS.market, 10);
  });

  it("no override → context.realReturnUsed === effective (weighted tier mix)", () => {
    const { context } = calculateFireForScope(
      BASE_CONFIG,
      [makeAsset("stocks", 600_000, "market"), makeAsset("cash", 400_000, "cash")],
      [],
      workspace,
      "alice",
    );

    // 60% market + 40% cash → 3%
    expect(context.effectiveRealReturn).toBeCloseTo(0.03, 10);
    expect(context.realReturnUsed).toBeCloseTo(context.effectiveRealReturn, 10);
  });
});

describe("the context is what every projection consumes", () => {
  it("projectFireFromContext's base scenario uses context.realReturnUsed verbatim", () => {
    const { context } = calculateFireForScope(
      BASE_CONFIG,
      [makeAsset("stocks", 600_000, "market"), makeAsset("cash", 400_000, "cash")],
      [],
      workspace,
      "alice",
    );

    const base = projectFireFromContext(context, {
      monthlyContributionMinor: 0,
    }).scenarios.find((s) => s.label === "base")!;
    expect(base.annualReturn).toBeCloseTo(context.realReturnUsed, 10);
  });

  it("withRate is the ONLY way to override — explicit, never by omission", () => {
    const { context } = calculateFireForScope(
      BASE_CONFIG,
      [makeAsset("stocks", 1_000_000, "market")],
      [],
      workspace,
      "alice",
    );

    const whatIf = withRate(context, 0.09);
    expect(whatIf.realReturnUsed).toBeCloseTo(0.09, 10);
    // Everything else rides along unchanged — only the rate moved.
    expect(whatIf.eligibleMinor).toBe(context.eligibleMinor);
    expect(whatIf.fireNumberMinor).toBe(context.fireNumberMinor);
    // The original context is untouched (immutable override).
    expect(context.realReturnUsed).not.toBeCloseTo(0.09, 10);

    const whatIfBase = projectFireFromContext(whatIf, {
      monthlyContributionMinor: 0,
    }).scenarios.find((s) => s.label === "base")!;
    expect(whatIfBase.annualReturn).toBeCloseTo(0.09, 10);
  });
});
