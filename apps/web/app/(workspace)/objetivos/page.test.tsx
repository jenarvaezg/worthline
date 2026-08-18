import type { ContributionPlan, FireScopeConfig } from "@worthline/domain";
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
    readFireConfig: vi.fn(
      async (): Promise<Record<string, FireScopeConfig>> => ({
        household: {
          monthlySpendingMinor: 200_000,
          safeWithdrawalRate: 0.04,
          expectedRealReturn: 0.05,
        },
      }),
    ),
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
    resolvePageShell: vi.fn(async () => {
      const scopes = [{ id: "household", label: "Hogar", type: "household" }];
      return {
        persistence: {
          checkedAt: "2026-07-03T00:00:00.000Z",
          checkKey: "bootstrap.last_healthcheck_at",
          checkValue: "2026-07-03T00:00:00.000Z",
          databasePath: ":memory:",
          displayPath: ":memory:",
          status: "ok",
        },
        privacyMode: false,
        requestedScopeId: undefined,
        scopes,
        selectedScope: scopes[0],
        store: {
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
        },
        target: { kind: "local" },
        workspace: await calls.readWorkspace(),
      };
    }),
  };
});

vi.mock("@web/page-shell", () => ({
  resolvePageShell: calls.resolvePageShell,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
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
import { ObjetivosContent } from "./page";

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderedHtml(
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  const element = (await ObjetivosContent({
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

describe("ObjetivosPage capital split (#1447)", () => {
  /** Jorge's shape: brick is two thirds of the pool, with its own mortgage. */
  function landlordLedger() {
    return {
      assets: [
        {
          id: "asset_etf",
          name: "Fondos",
          type: "investment",
          currency: "EUR",
          currentValue: { amountMinor: 143_370_75, currency: "EUR" },
          liquidityTier: "market",
          ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
          isPrimaryResidence: false,
        },
        {
          id: "asset_pension",
          name: "Plan de pensiones",
          type: "manual",
          currency: "EUR",
          currentValue: { amountMinor: 10_556_58, currency: "EUR" },
          liquidityTier: "term-locked",
          ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
          isPrimaryResidence: false,
        },
        {
          id: "asset_rental",
          name: "Piso de Plasencia",
          type: "real_estate",
          currency: "EUR",
          currentValue: { amountMinor: 370_000_00, currency: "EUR" },
          liquidityTier: "housing",
          ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
          isPrimaryResidence: false,
        },
      ],
      liabilities: [
        {
          id: "liability_mortgage",
          name: "Hipoteca Plasencia",
          type: "mortgage",
          currency: "EUR",
          currentBalance: { amountMinor: 68_628_03, currency: "EUR" },
          ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
          associatedAssetId: "asset_rental",
        },
      ],
    };
  }

  test("shows what can be sold in slices apart from what cannot", async () => {
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce(landlordLedger());
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.035,
        expectedRealReturn: 0.05,
      },
    });

    const html = await renderedHtml();

    expect(html).toContain("vendible");
    expect(html).toContain("inmovilizado");
    // Sellable = mercado 143.370,75 + plazo 10.556,58; the mortgage never touches it.
    expect(html).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 153_927_33, currency: "EUR" }, false),
    );
    // Immobilized = 370.000,00 − 68.628,03: the debt nets inside the brick.
    expect(html).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 301_371_97, currency: "EUR" }, false),
    );
  });

  test("says what the sellable side alone funds, inside the eligibility disclosure", async () => {
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce(landlordLedger());
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.035,
        expectedRealReturn: 0.05,
      },
    });

    const html = await renderedHtml();

    // 455.299,30 / 685.714,29 = 66,4 % of the pool — the hero figure is unchanged.
    expect(html).toContain('<p class="fireBig">66,4 %</p>');
    // … but only 153.927,33 / 685.714,29 = 22,4 % of it can be spent in
    // instalments. That caveat lives inside «¿Qué cuenta como activo elegible?»,
    // not in the hero: #1447 splits the capital, it does not restate the %.
    const disclosure = html.slice(html.indexOf('<details class="fireEligibleNote"'));
    expect(disclosure.slice(0, disclosure.indexOf("</details>"))).toContain("22,4 %");
  });

  test("stays out of the way when nothing in the pool is immobilized", async () => {
    const html = await renderedHtml();

    expect(html).not.toContain("inmovilizado");
  });
});

describe("ObjetivosPage measured savings (#1449)", () => {
  /**
   * The 12 calendar months ending this month. Relative to the real clock because
   * the page reads it: months hard-coded to 2026 would drift out of the
   * measurement window as time passes and turn this guard green for the wrong
   * reason.
   */
  function trailingMonths(): string[] {
    const now = new Date();
    return Array.from({ length: 12 }, (_, index) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - index), 1))
        .toISOString()
        .slice(0, 7),
    );
  }

  /** 100 €/month in, and one 5.000 € withdrawal: the ledger goes down. */
  function dissavingLedger() {
    const months = trailingMonths();
    return [
      ...months.map((month) => ({
        id: `op_buy_${month}`,
        assetId: "asset_fondo",
        kind: "buy" as const,
        executedAt: `${month}-10`,
        units: "100",
        pricePerUnit: "1",
        currency: "EUR" as const,
        feesMinor: 0,
      })),
      {
        id: "op_sell_big",
        assetId: "asset_fondo",
        kind: "sell" as const,
        executedAt: `${months[6]}-10`,
        units: "5000",
        pricePerUnit: "1",
        currency: "EUR" as const,
        feesMinor: 0,
      },
    ];
  }

  /** The base fixture plus an investment holding that carries the ledger. */
  function ledgerHoldings() {
    const fondo = {
      id: "asset_fondo",
      name: "Fondo indexado",
      type: "investment",
      currency: "EUR",
      currentValue: { amountMinor: 1_000_00, currency: "EUR" },
      liquidityTier: "market",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      isPrimaryResidence: false,
    };
    return {
      assets: [
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
        fondo,
      ],
      liabilities: [],
    };
  }

  /**
   * FIRE number = 100 € × 12 / 0,04 = 30.000 €, under the 101.000 € of eligible
   * capital: funded on paper, whatever the ledger says. 1.500 €/mes declared.
   */
  function seedFundedScope(): void {
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        monthlySpendingMinor: 10_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.05,
        monthlySavingsCapacityMinor: 150_000,
      },
    });
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce(ledgerHoldings());
    calls.buildProjectionContext.mockResolvedValueOnce({
      cachedPriceByAsset: new Map(),
      manualPriceByAsset: new Map(),
      operationsByAsset: new Map([["asset_fondo", dissavingLedger()]]),
    });
  }

  // The veto lives in the domain, but only fires if this page hands the ledger to
  // it — and only shows if the hero draws the attenuated badge instead of the green
  // one. Both halves are asserted on the rendered markup.
  test("draws the badge attenuated, with the measured figure and the gap", async () => {
    seedFundedScope();

    const html = await renderedHtml();

    expect(html).toContain("sobre el papel");
    expect(html).not.toContain(">FIRE alcanzado<");
    expect(html).toContain("Declaras ahorrar");
  });

  test("leaves the badge green when the ledger backs the declaration", async () => {
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        monthlySpendingMinor: 10_000,
        safeWithdrawalRate: 0.04,
        expectedRealReturn: 0.05,
        monthlySavingsCapacityMinor: 10_000,
      },
    });
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce(ledgerHoldings());
    calls.buildProjectionContext.mockResolvedValueOnce({
      cachedPriceByAsset: new Map(),
      manualPriceByAsset: new Map(),
      operationsByAsset: new Map([
        [
          "asset_fondo",
          dissavingLedger().filter((operation) => operation.kind === "buy"),
        ],
      ]),
    });

    const html = await renderedHtml();

    expect(html).toContain(">FIRE alcanzado<");
    expect(html).not.toContain("sobre el papel");
    expect(html).not.toContain("Declaras ahorrar");
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
