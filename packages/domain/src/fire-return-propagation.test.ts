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
import { projectFireWithContributionPlan } from "./fire-plan-projection";
import { projectFire } from "./fire-projection";
import { TIER_REAL_RETURN_DEFAULTS } from "./fire-return";
import type { ContributionPlan, ManualAsset, Workspace } from "./index";

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

// ---------------------------------------------------------------------------
// The single projection door (#1122): the door must reproduce, verbatim, what
// the scalar engine and the contribution-plan engine produced when callers
// reached for them directly — so re-routing every entry through it cannot move
// a single figure.
// ---------------------------------------------------------------------------

describe("projectFireFromContext is the single door with no numeric drift", () => {
  const { context } = calculateFireForScope(
    BASE_CONFIG,
    [makeAsset("stocks", 600_000, "market"), makeAsset("cash", 400_000, "cash")],
    [],
    workspace,
    "alice",
  );

  it("scalar mode equals the internal projectFire engine, defaults drawn from the context", () => {
    const viaDoor = projectFireFromContext(context, {
      monthlyContributionMinor: 50_000,
    });
    const direct = projectFire({
      startingEligibleMinor: context.eligibleMinor,
      monthlyContributionMinor: 50_000,
      expectedRealReturn: context.realReturnUsed,
      fireNumberMinor: context.fireNumberMinor,
    });
    expect(viaDoor).toEqual(direct);
  });

  it("honours the fireNumberMinor override (the level rail projects to Fat)", () => {
    const fat = context.fireNumberMinor * 2;
    const viaDoor = projectFireFromContext(context, {
      monthlyContributionMinor: 50_000,
      fireNumberMinor: fat,
    });
    expect(viaDoor.fireNumberMinor).toBe(fat);
    expect(viaDoor).toEqual(
      projectFire({
        startingEligibleMinor: context.eligibleMinor,
        monthlyContributionMinor: 50_000,
        expectedRealReturn: context.realReturnUsed,
        fireNumberMinor: fat,
      }),
    );
  });

  it("honours the startingEligibleMinor override (goal-delay's with/without probes)", () => {
    const viaDoor = projectFireFromContext(context, {
      monthlyContributionMinor: 0,
      startingEligibleMinor: 123_456,
    });
    expect(viaDoor).toEqual(
      projectFire({
        startingEligibleMinor: 123_456,
        monthlyContributionMinor: 0,
        expectedRealReturn: context.realReturnUsed,
        fireNumberMinor: context.fireNumberMinor,
      }),
    );
  });

  it("plan mode equals the internal contribution-plan engine (the what-if)", () => {
    const plan: ContributionPlan = {
      scopeId: "scope-1",
      contributions: [
        {
          id: "c1",
          destinationHoldingId: "h1",
          amount: { mode: "money", value: 100_000 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-01-01",
        },
      ],
    };
    const holdingAnnualReturnById = { h1: 0.06 };

    const viaDoor = projectFireFromContext(context, {
      plan,
      growthAssumption: "historical",
      assumedAnnualReturn: context.realReturnUsed,
      holdingAnnualReturnById,
      todayISO: "2026-01-01",
    });
    const direct = projectFireWithContributionPlan({
      startingEligibleMinor: context.eligibleMinor,
      expectedRealReturn: context.realReturnUsed,
      fireNumberMinor: context.fireNumberMinor,
      todayISO: "2026-01-01",
      plan,
      growthAssumption: "historical",
      assumedAnnualReturn: context.realReturnUsed,
      holdingAnnualReturnById,
    });
    expect(viaDoor).toEqual(direct);
  });
});
