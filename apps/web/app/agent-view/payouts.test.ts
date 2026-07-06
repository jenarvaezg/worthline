import type { AgentViewReadStore } from "@worthline/db";
import type {
  FireScopeConfig,
  Payout,
  PayoutSchedule,
  Workspace,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { derivePublicId } from "./derived-id";
import { buildHoldingPayouts, buildScopePassiveIncome } from "./payouts";

const TODAY = "2026-07-06";

/** A read-only fake exposing only the payout/schedule-for-holding reads. */
function holdingStore(
  payoutsById: Record<string, Payout[]>,
  schedulesById: Record<string, PayoutSchedule[]>,
): AgentViewReadStore {
  return {
    readPayoutsForHolding: async (holdingId: string) => payoutsById[holdingId] ?? [],
    readPayoutSchedulesForHolding: async (holdingId: string) =>
      schedulesById[holdingId] ?? [],
  } as unknown as AgentViewReadStore;
}

function payout(over: Partial<Payout> & Pick<Payout, "id" | "holdingId">): Payout {
  return {
    dateISO: "2026-03-01",
    amountMinor: 1_200_000,
    ...over,
  };
}

function schedule(
  over: Partial<PayoutSchedule> & Pick<PayoutSchedule, "id" | "holdingId">,
): PayoutSchedule {
  return {
    label: "Alquiler",
    amountMinor: 90_000,
    cadence: "monthly",
    startISO: "2025-01-01",
    endISO: null,
    exclusions: [],
    ...over,
  };
}

describe("buildHoldingPayouts", () => {
  test("returns null when the holding has neither payouts nor schedules", async () => {
    const result = await buildHoldingPayouts({
      store: holdingStore({}, {}),
      assetId: "h1",
      currency: "EUR",
      todayISO: TODAY,
    });
    expect(result).toBeNull();
  });

  test("maps recorded one-offs to DTOs with a stable derived public id", async () => {
    const result = await buildHoldingPayouts({
      store: holdingStore(
        { h1: [payout({ id: "p1", holdingId: "h1", note: "Dividendo" })] },
        {},
      ),
      assetId: "h1",
      currency: "EUR",
      todayISO: TODAY,
    });

    expect(result!.recorded).toEqual([
      {
        id: derivePublicId("pay", "p1"),
        object: "payout",
        date: "2026-03-01",
        amount: { amountMinor: 1_200_000, currency: "EUR" },
        note: "Dividendo",
      },
    ]);
    // opaque, prefixed, leaks no internal id (ADR 0023)
    expect(result!.recorded[0]?.id).toMatch(/^wl_pay_[0-9a-f]{32}$/);
    expect(result!.recorded[0]?.id).not.toContain("p1");
  });

  test("exposes a schedule's declaration only — never materialized occurrences", async () => {
    const result = await buildHoldingPayouts({
      store: holdingStore(
        {},
        {
          h1: [
            schedule({
              id: "s1",
              holdingId: "h1",
              cadence: "monthly",
              startISO: "2025-01-01",
              endISO: "2026-06-30",
              exclusions: ["2025-08-01"],
            }),
          ],
        },
      ),
      assetId: "h1",
      currency: "EUR",
      todayISO: TODAY,
    });

    expect(result!.schedules).toEqual([
      {
        id: derivePublicId("psc", "s1"),
        object: "payout_schedule",
        label: "Alquiler",
        cadence: "monthly",
        amount: { amountMinor: 90_000, currency: "EUR" },
        startDate: "2025-01-01",
        endDate: "2026-06-30",
        exclusions: ["2025-08-01"],
      },
    ]);
    // The declaration list carries no derived occurrences (they live in trailing12m).
    expect(result!.recorded).toEqual([]);
    expect(result!.schedules[0]?.id).toMatch(/^wl_psc_[0-9a-f]{32}$/);
  });

  test("trailing12m sums one-offs and derived occurrences inside the window", async () => {
    const result = await buildHoldingPayouts({
      store: holdingStore(
        {
          h1: [
            payout({
              id: "p1",
              holdingId: "h1",
              dateISO: "2026-03-01",
              amountMinor: 500_000,
            }),
            // Older than the 12m window (todayISO − 12 months = 2025-07-06, exclusive).
            payout({
              id: "p0",
              holdingId: "h1",
              dateISO: "2024-01-01",
              amountMinor: 999_999,
            }),
          ],
        },
        {
          // Monthly 90_000 from 2025-01-01: occurrences inside (2025-07-06, 2026-07-06].
          h1: [schedule({ id: "s1", holdingId: "h1", amountMinor: 90_000 })],
        },
      ),
      assetId: "h1",
      currency: "EUR",
      todayISO: TODAY,
    });

    // 12 monthly occurrences (Aug 2025 … Jul 2026) × 90_000 + one 500_000 one-off.
    expect(result!.trailing12m.count).toBe(13);
    expect(result!.trailing12m.total).toEqual({
      amountMinor: 12 * 90_000 + 500_000,
      currency: "EUR",
    });
    expect(result!.trailing12m.windowEnd).toBe(TODAY);
    expect(result!.trailing12m.months).toBe(12);
  });
});

// ── scope passive income ──────────────────────────────────────────────────────
//
// Caller-resolved like `buildPortfolioReturns`: scope resolution / public-id
// handling lives in `buildFinancialContext` and is exercised end-to-end by
// `payouts-wiring.test.ts`. These tests fix the weighting / coverage math.

function scopeStore(over: {
  payouts: Payout[];
  schedules: PayoutSchedule[];
  fireConfig: Record<string, FireScopeConfig>;
}): AgentViewReadStore {
  return {
    readPayouts: async () => over.payouts,
    readPayoutSchedules: async () => over.schedules,
    readFireConfig: async () => over.fireConfig,
  } as unknown as AgentViewReadStore;
}

const workspace = {
  baseCurrency: "EUR",
  groups: [],
  members: [
    { id: "member_jose", name: "Jose" },
    { id: "member_ana", name: "Ana" },
  ],
  mode: "household",
} as unknown as Workspace;

function ownedAsset(
  id: string,
  shares: { memberId: string; shareBps: number }[],
): { id: string; ownership: { memberId: string; shareBps: number }[] } {
  return { id, ownership: shares };
}

describe("buildScopePassiveIncome", () => {
  test("weights a co-owned holding by the scope's ownership share and reports coverage", async () => {
    const result = await buildScopePassiveIncome({
      store: scopeStore({
        payouts: [
          payout({
            id: "rent",
            holdingId: "home",
            dateISO: "2026-03-01",
            amountMinor: 3_000_000,
          }),
        ],
        schedules: [],
        fireConfig: {
          member_jose: { monthlySpendingMinor: 125_000 } as unknown as FireScopeConfig,
        },
      }),
      workspace,
      internalScopeId: "member_jose",
      holdings: [
        ownedAsset("home", [
          { memberId: "member_jose", shareBps: 5_000 },
          { memberId: "member_ana", shareBps: 5_000 },
        ]),
      ],
      todayISO: TODAY,
    });

    // 3.000.000 × 50% scope ownership = 1.500.000.
    expect(result.total).toEqual({ amountMinor: 1_500_000, currency: "EUR" });
    expect(result.count).toBe(1);
    expect(result.hasPayouts).toBe(true);
    expect(result.windowEnd).toBe(TODAY);
    // annual spending 125_000 × 12 = 1_500_000 → coverage 1.
    expect(result.annualSpending).toEqual({ amountMinor: 1_500_000, currency: "EUR" });
    expect(result.coverageRatio).toBe("1");
  });

  test("omits coverage when the scope has no declared spending", async () => {
    const result = await buildScopePassiveIncome({
      store: scopeStore({
        payouts: [payout({ id: "rent", holdingId: "home", amountMinor: 100_000 })],
        schedules: [],
        fireConfig: {},
      }),
      workspace,
      internalScopeId: "member_jose",
      holdings: [ownedAsset("home", [{ memberId: "member_jose", shareBps: 10_000 }])],
      todayISO: TODAY,
    });

    expect(result.annualSpending).toBeNull();
    expect(result.coverageRatio).toBeNull();
    expect(result.hasPayouts).toBe(true);
  });

  test("excludes payouts of a holding the scope does not own", async () => {
    const result = await buildScopePassiveIncome({
      store: scopeStore({
        payouts: [payout({ id: "rent", holdingId: "anas", amountMinor: 500_000 })],
        schedules: [],
        fireConfig: {},
      }),
      workspace,
      internalScopeId: "member_jose",
      holdings: [ownedAsset("anas", [{ memberId: "member_ana", shareBps: 10_000 }])],
      todayISO: TODAY,
    });

    expect(result.total).toEqual({ amountMinor: 0, currency: "EUR" });
    expect(result.count).toBe(0);
    expect(result.hasPayouts).toBe(false);
  });
});
