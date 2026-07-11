import { describe, expect, it } from "vitest";

import type { ContributionPlan, PlannedContribution } from "./contribution-plan";
import { projectExposureDrift } from "./exposure-drift-projection";
import {
  createExposureProfile,
  type ExposureLookthroughHolding,
  type ExposureProfile,
} from "./exposure-lookthrough";

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
});
