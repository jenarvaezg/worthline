import type { ContributionPlan } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => {
  const projectionContext = {
    cachedPriceByAsset: new Map(),
    manualPriceByAsset: new Map(),
    operationsByAsset: new Map(),
  };
  const assets = [
    {
      id: "asset_home",
      name: "Casa",
      type: "real_estate",
      currency: "EUR",
      currentValue: { amountMinor: 500_000_00, currency: "EUR" },
      liquidityTier: "illiquid",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      isPrimaryResidence: true,
    },
    {
      id: "asset_cash",
      name: "Caja",
      type: "cash",
      currency: "EUR",
      currentValue: { amountMinor: 100_000_00, currency: "EUR" },
      liquidityTier: "cash",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      isPrimaryResidence: false,
    },
  ];
  const liabilities = [
    {
      id: "liability_unsecured",
      name: "Préstamo",
      type: "debt",
      currency: "EUR",
      currentBalance: { amountMinor: 50_000_00, currency: "EUR" },
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    },
  ];

  return {
    buildProjectionContext: vi.fn(async () => projectionContext),
    projectionContext,
    readAssets: vi.fn(async () => assets),
    readCurveValuedHoldingsAtDate: vi.fn(async () => ({ assets, liabilities })),
    readFireConfig: vi.fn(async () => ({
      household: {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.05,
      },
    })),
    readGoals: vi.fn(async () => []),
    readPayouts: vi.fn(async () => [
      {
        id: "p_rent",
        holdingId: "asset_cash",
        dateISO: "2026-03-01",
        amountMinor: 1_200_000,
      },
    ]),
    readPayoutSchedules: vi.fn(async () => []),
    readWarningOverrides: vi.fn(async () => []),
    readContributionPlan: vi.fn(
      async (): Promise<ContributionPlan> => ({
        scopeId: "household",
        contributions: [],
      }),
    ),
    readContributionReconciliations: vi.fn(async () => []),
    readOperations: vi.fn(async () => []),
    readAllPriceCacheEntries: vi.fn(async () => []),
    readInvestmentAssetsWithMeta: vi.fn(async () => []),
    readExposureProfiles: vi.fn(async () => []),
    readSnapshotHoldings: vi.fn(async () => []),
    readWorkspace: vi.fn(async () => ({
      baseCurrency: "EUR",
      groups: [],
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    })),
    withStore: vi.fn(async (run: (store: unknown) => unknown) =>
      run({
        assets: {
          readAssets: calls.readAssets,
          readInvestmentAssetsWithMeta: calls.readInvestmentAssetsWithMeta,
        },
        contributionPlan: {
          readContributionPlan: calls.readContributionPlan,
          readReconciliations: calls.readContributionReconciliations,
        },
        exposureProfiles: {
          readExposureProfiles: calls.readExposureProfiles,
        },
        goals: { readGoals: calls.readGoals },
        operations: {
          readAllPriceCacheEntries: calls.readAllPriceCacheEntries,
          readOperations: calls.readOperations,
        },
        payouts: {
          readPayouts: calls.readPayouts,
          readPayoutSchedules: calls.readPayoutSchedules,
        },
        readFireConfig: calls.readFireConfig,
        readWarningOverrides: calls.readWarningOverrides,
        snapshots: {
          buildProjectionContext: calls.buildProjectionContext,
          readCurveValuedHoldingsAtDate: calls.readCurveValuedHoldingsAtDate,
          readSnapshotHoldings: calls.readSnapshotHoldings,
        },
        workspace: { readWorkspace: calls.readWorkspace },
      }),
    ),
  };
});

vi.mock("@web/store", () => ({
  bootstrapHealthcheck: async () => ({
    checkedAt: "2026-07-03T00:00:00.000Z",
    checkKey: "bootstrap.last_healthcheck_at",
    checkValue: "2026-07-03T00:00:00.000Z",
    databasePath: ":memory:",
    displayPath: ":memory:",
    status: "ok",
  }),
  withStore: calls.withStore,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

vi.mock("@web/shell", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

vi.mock("@web/fire-projection-card", () => ({
  default: () => <div />,
}));

vi.mock("./exposure-drift-section", () => ({
  ExposureDriftSection: () => <div data-testid="exposure-drift" />,
}));

import {
  allocationMonthKeys,
  formatAllocationMonthLabel,
} from "./contribution-allocation-view";
import ObjetivosPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderedHtml(
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  const element = (await ObjetivosPage({
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe("ObjetivosPage contribution reconciliation (#556)", () => {
  test("keeps backlog and future occurrences visible and opens the focused drawer", async () => {
    calls.readContributionPlan.mockResolvedValueOnce({
      scopeId: "household",
      contributions: [
        {
          id: "plan-cash",
          destinationHoldingId: "asset_cash",
          amount: { mode: "money", value: 100_000 },
          cadence: { kind: "monthly", dayOfMonth: 1 },
          startDate: "2026-06-01",
        },
      ],
    });

    const html = await renderedHtml({ reconcile: "plan-cash:2026-07-01" });

    expect(html).toContain("Mapa de capital");
    expect(html).toContain("atrasada");
    expect(html).toContain("prevista");
    expect(html).toContain("Registrar la realidad");
    expect(html).toContain("Aplicar actualización de saldo");
  });
});

describe("ObjetivosPage monthly allocation view (#557)", () => {
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthWindow = allocationMonthKeys(todayISO);
  const currentMonthLabel = formatAllocationMonthLabel(monthWindow[1] ?? "");

  const planWithMonthlyCash = (): ContributionPlan => ({
    scopeId: "household",
    contributions: [
      {
        id: "plan-cash",
        destinationHoldingId: "asset_cash",
        amount: { mode: "money", value: 100_000 },
        cadence: { kind: "monthly", dayOfMonth: 1 },
        startDate: "2026-01-01",
      },
    ],
  });

  test("renders the current month's split across destinations by default", async () => {
    calls.readContributionPlan.mockResolvedValueOnce(planWithMonthlyCash());

    const html = await renderedHtml();

    expect(html).toContain("Reparto mensual");
    expect(html).toContain(`Previsto · ${currentMonthLabel}`);
    expect(html).toContain("Caja");
    expect(html).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 100_000, currency: "EUR" }, false),
    );
    // Current month is the pressed tab in the server-rendered markup.
    expect(html).toContain(`aria-pressed="true" type="button">${currentMonthLabel}`);
  });

  test("deep-links a month of the window via ?mes=", async () => {
    calls.readContributionPlan.mockResolvedValueOnce(planWithMonthlyCash());
    const nextMonth = monthWindow[2] ?? "";

    const html = await renderedHtml({ mes: nextMonth });

    expect(html).toContain(
      `aria-pressed="true" type="button">${formatAllocationMonthLabel(nextMonth)}`,
    );
  });

  test("stays hidden when the plan has no contributions", async () => {
    const html = await renderedHtml();

    expect(html).not.toContain("Reparto mensual");
  });
});

describe("ObjetivosPage FIRE wiring", () => {
  test("uses the same curve-valued ledger as the dashboard for FIRE figures", async () => {
    const html = await renderedHtml();

    expect(calls.buildProjectionContext).toHaveBeenCalledTimes(1);
    expect(calls.readCurveValuedHoldingsAtDate).toHaveBeenCalledWith(
      expect.any(String),
      calls.projectionContext,
    );
    expect(calls.readAssets).not.toHaveBeenCalled();
    expect(html).toContain("8,3 %");
    expect(html).toContain("50.000");
    expect(html).toContain("Casa");
    expect(html).toContain("vivienda habitual");
  });
});

describe("ObjetivosPage passive-income lens (#658)", () => {
  test("renders the scope's trailing payouts and coverage vs declared spending", async () => {
    const html = await renderedHtml();

    // asset_cash is fully owned by the scope → its 12.000,00 € payout attributes whole.
    expect(html).toContain("Renta pasiva");
    expect(html).toContain("12.000");
    // coverage = 1.200.000 / (200.000 · 12 = 2.400.000) = 50 %
    expect(html).toContain("50,0 %");
    // window/coverage honesty: the annualization caveat is visible on the surface.
    expect(html.toLowerCase()).toContain("anualizar");
  });

  test("weights the payout by the scope's ownership share of the holding", async () => {
    // asset_cash owned 50% by the scope member → half the payout attributes.
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce({
      assets: [
        {
          id: "asset_cash",
          name: "Caja",
          type: "cash",
          currency: "EUR",
          currentValue: { amountMinor: 100_000_00, currency: "EUR" },
          liquidityTier: "cash",
          ownership: [
            { memberId: "member_jose", shareBps: 5_000 },
            { memberId: "member_ext", shareBps: 5_000 },
          ],
          isPrimaryResidence: false,
        },
      ],
      liabilities: [],
    });
    calls.readPayouts.mockResolvedValueOnce([
      {
        id: "p_rent",
        holdingId: "asset_cash",
        dateISO: "2026-03-01",
        amountMinor: 3_000_000,
      },
    ]);

    const html = await renderedHtml();

    // 30.000 € payout × 50% scope ownership = 15.000 €
    expect(html).toContain("15.000");
    expect(html).not.toContain("30.000");
  });

  test("shows an empty state when the scope has recorded no payouts", async () => {
    calls.readPayouts.mockResolvedValueOnce([]);
    calls.readPayoutSchedules.mockResolvedValueOnce([]);

    const html = await renderedHtml();

    expect(html).toContain("Renta pasiva");
    expect(html.toLowerCase()).toContain("aún no");
  });
});
