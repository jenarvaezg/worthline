import { describe, expect, it } from "vitest";

import type { ContributionPlan, PlannedContribution } from "./contribution-plan";
import {
  assembleExposureDriftHoldings,
  holdingAnnualReturnByIdForProjection,
  projectExposureDrift,
} from "./exposure-drift-projection";
import {
  createExposureProfile,
  type ExposureLookthroughHolding,
  type ExposureProfile,
} from "./exposure-lookthrough";
import { createManualAsset, createWorkspace } from "./workspace-types";

function contribution(overrides: Partial<PlannedContribution> = {}): PlannedContribution {
  return {
    id: "c1",
    destinationHoldingId: "h_us",
    amount: { mode: "money", value: 100_000 },
    cadence: { kind: "monthly", dayOfMonth: 1 },
    startDate: "2026-01-01",
    ...overrides,
  };
}

function plan(
  contributions: PlannedContribution[],
  scopeId = "scope-1",
): ContributionPlan {
  return { scopeId, contributions };
}

const EUR = "EUR" as const;

const usProfile = createExposureProfile({
  key: "IE00US",
  breakdowns: {
    assetClass: { equity: "1" },
    currency: { USD: "1" },
    geography: { us: "1" },
  },
});

const europeProfile = createExposureProfile({
  key: "IE00EU",
  breakdowns: {
    assetClass: { equity: "1" },
    currency: { EUR: "1" },
    geography: { europe_developed: "1" },
  },
});

function profiles(
  entries: Array<[string, ExposureProfile]>,
): ReadonlyMap<string, ExposureProfile> {
  return new Map(entries);
}

function holding(
  overrides: Partial<ExposureLookthroughHolding> & Pick<ExposureLookthroughHolding, "id">,
): ExposureLookthroughHolding {
  return {
    currency: EUR,
    instrument: "etf",
    valueMinor: 0,
    ...overrides,
  };
}

const BASE = {
  todayISO: "2026-01-01",
  baseCurrency: EUR,
  assumedAnnualReturn: 0.05,
  maxYears: 5,
} as const;

describe("projectExposureDrift", () => {
  it("starts from present-time look-through and shifts geography when contributions target another region", () => {
    const holdings: ExposureLookthroughHolding[] = [
      holding({
        id: "h_eu",
        isin: "IE00EU",
        valueMinor: 1_000_000,
      }),
      holding({
        id: "h_us",
        isin: "IE00US",
        valueMinor: 0,
      }),
    ];

    const projection = projectExposureDrift({
      ...BASE,
      growthAssumption: "flat",
      plan: plan([contribution()]),
      holdings,
      profiles: profiles([
        ["IE00EU", europeProfile],
        ["IE00US", usProfile],
      ]),
    });

    const year0 = projection.trajectory[0]!;
    const year5 = projection.trajectory[5]!;
    const usWeightAtStart = year0.geography.slices.find(
      (slice) => slice.key === "us",
    )?.weight;
    const usWeightAtEnd = year5.geography.slices.find(
      (slice) => slice.key === "us",
    )?.weight;

    expect(
      year0.geography.slices.find((slice) => slice.key === "europe_developed")?.weight,
    ).toBe("1");
    expect(usWeightAtStart).toBeUndefined();
    expect(Number(usWeightAtEnd ?? "0")).toBeGreaterThan(0);
    expect(Number(usWeightAtEnd ?? "0")).toBeLessThan(1);
  });

  it("uses historical per-holding growth so a faster-growing destination drifts composition", () => {
    const holdings: ExposureLookthroughHolding[] = [
      holding({
        id: "h_eu",
        isin: "IE00EU",
        valueMinor: 500_000,
      }),
      holding({
        id: "h_us",
        isin: "IE00US",
        valueMinor: 500_000,
      }),
    ];

    const flat = projectExposureDrift({
      ...BASE,
      growthAssumption: "flat",
      plan: plan([]),
      holdings,
      profiles: profiles([
        ["IE00EU", europeProfile],
        ["IE00US", usProfile],
      ]),
    });
    const historical = projectExposureDrift({
      ...BASE,
      growthAssumption: "historical",
      holdingAnnualReturnById: { h_eu: 0.02, h_us: 0.12 },
      plan: plan([]),
      holdings,
      profiles: profiles([
        ["IE00EU", europeProfile],
        ["IE00US", usProfile],
      ]),
    });

    const flatUs = Number(
      flat.trajectory[5]!.geography.slices.find((slice) => slice.key === "us")?.weight ??
        "0",
    );
    const historicalUs = Number(
      historical.trajectory[5]!.geography.slices.find((slice) => slice.key === "us")
        ?.weight ?? "0",
    );

    expect(historicalUs).toBeGreaterThan(flatUs);
  });

  it("preserves three-way coverage honesty for unknown profiles", () => {
    const holdings: ExposureLookthroughHolding[] = [
      holding({
        id: "h_known",
        isin: "IE00EU",
        valueMinor: 600_000,
      }),
      holding({
        id: "h_unknown",
        instrument: "fund",
        valueMinor: 400_000,
      }),
    ];

    const projection = projectExposureDrift({
      ...BASE,
      growthAssumption: "flat",
      plan: plan([]),
      holdings,
      profiles: profiles([["IE00EU", europeProfile]]),
    });

    const year0 = projection.trajectory[0]!;
    expect(year0.geography.coverage.classified.amountMinor).toBe(600_000);
    expect(year0.geography.coverage.unknown.amountMinor).toBe(400_000);
    expect(year0.assetClass.coverage.unknown.amountMinor).toBe(400_000);
  });

  it("returns an empty trajectory when there are no holdings", () => {
    const projection = projectExposureDrift({
      ...BASE,
      growthAssumption: "flat",
      plan: plan([contribution()]),
      holdings: [],
      profiles: profiles([]),
    });

    expect(projection.trajectory).toEqual([]);
  });

  it("excludes contributions to a destination outside the holdings set instead of distorting weights", () => {
    const holdings: ExposureLookthroughHolding[] = [
      holding({ id: "h_eu", isin: "IE00EU", valueMinor: 1_000_000 }),
    ];

    const projection = projectExposureDrift({
      ...BASE,
      growthAssumption: "flat",
      plan: plan([contribution({ id: "c_ghost", destinationHoldingId: "h_ghost" })]),
      holdings,
      profiles: profiles([["IE00EU", europeProfile]]),
    });

    // A plan destination that is not a known holding cannot be looked through:
    // its money is excluded from both the look-through and the gross denominator,
    // so coverage always sums to gross and the known weights stay honest.
    for (const point of projection.trajectory) {
      const coverageSum =
        point.geography.coverage.classified.amountMinor +
        point.geography.coverage.notApplicable.amountMinor +
        point.geography.coverage.unknown.amountMinor;
      expect(coverageSum).toBe(point.grossAssets.amountMinor);
    }
    const year5 = projection.trajectory[5]!;
    expect(year5.grossAssets.amountMinor).toBe(1_000_000);
    expect(
      year5.geography.slices.find((slice) => slice.key === "europe_developed")?.weight,
    ).toBe("1");
  });
});

describe("assembleExposureDriftHoldings", () => {
  const workspace = createWorkspace({
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
    mode: "household",
  });
  const scope = { id: "member_ana", label: "Ana", type: "member" as const };
  const listedHolding = createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 500_000,
    id: "h_listed",
    liquidityTier: "market",
    name: "ETF Europa",
    ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
    type: "investment",
  });
  const outOfScopeDestination = createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 0,
    id: "h_plan_only",
    liquidityTier: "market",
    name: "ETF US",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
  });
  const inScopeDestination = createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 0,
    id: "h_plan_only",
    liquidityTier: "market",
    name: "ETF US in scope",
    ownership: [{ memberId: "member_ana", shareBps: 10_000 }],
    type: "investment",
  });
  const europeProfile = createExposureProfile({
    key: "IE00EU",
    breakdowns: {
      assetClass: { equity: "1" },
      currency: { EUR: "1" },
      geography: { europe_developed: "1" },
    },
  });

  it("maps scoped portfolio rows and appends zero-value plan destinations", () => {
    const contributionPlan: ContributionPlan = {
      scopeId: "member_ana",
      contributions: [
        {
          id: "c1",
          destinationHoldingId: "h_plan_only",
          amount: { mode: "money", value: 100_00 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-01-01",
        },
      ],
    };

    const { holdings, profiles } = assembleExposureDriftHoldings({
      baseCurrency: "EUR",
      workspace,
      scope,
      assets: [listedHolding, outOfScopeDestination],
      liabilities: [],
      investmentMeta: [
        { id: "h_listed", isin: "IE00EU", providerSymbol: "EUNL.DE" },
        { id: "h_plan_only", isin: "IE00US", providerSymbol: "CSPX.L" },
      ],
      exposureProfiles: [europeProfile],
      plan: contributionPlan,
    });

    expect(holdings).toEqual([
      {
        currency: "EUR",
        geography: null,
        id: "h_listed",
        instrument: "fund",
        isin: "IE00EU",
        providerSymbol: "EUNL.DE",
        valueMinor: 500_000,
      },
      {
        currency: "EUR",
        geography: null,
        id: "h_plan_only",
        instrument: "fund",
        isin: "IE00US",
        providerSymbol: "CSPX.L",
        valueMinor: 0,
      },
    ]);
    expect(profiles.get("IE00EU")).toEqual(europeProfile);
  });

  it("does not duplicate holdings already present in the portfolio", () => {
    const contributionPlan: ContributionPlan = {
      scopeId: "member_ana",
      contributions: [
        {
          id: "c1",
          destinationHoldingId: "h_listed",
          amount: { mode: "money", value: 100_00 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-01-01",
        },
      ],
    };

    const { holdings } = assembleExposureDriftHoldings({
      baseCurrency: "EUR",
      workspace,
      scope,
      assets: [listedHolding, inScopeDestination],
      liabilities: [],
      investmentMeta: [],
      exposureProfiles: [],
      plan: contributionPlan,
    });

    expect(holdings.map((holding) => holding.id)).toEqual(["h_listed", "h_plan_only"]);
  });
});

describe("holdingAnnualReturnByIdForProjection", () => {
  it("resolves each holding through the shared projection return order", () => {
    const returnsById = new Map([
      [
        "h1",
        {
          kind: "market" as const,
          totalGain: { amountMinor: 1, currency: "EUR" },
          totalReturnRatio: 0.1,
          annualized: true,
          cagr: 0.04,
          irr: { rate: 0.06, reason: null },
          twr: {
            rate: 0.07,
            annualizedRate: 0.08,
            annualized: true,
            startDate: "2025-01-01",
            endDate: "2026-01-01",
            spanDays: 365,
            reason: null,
          },
          realizedPnl: null,
          unrealizedPnl: null,
          caveats: [],
        },
      ],
      ["h2", null],
    ]);

    expect(
      holdingAnnualReturnByIdForProjection({
        holdingIds: ["h1", "h2"],
        returnsById,
        assumedAnnualReturn: 0.05,
      }),
    ).toEqual({
      h1: 0.08,
      h2: 0.05,
    });
  });
});
