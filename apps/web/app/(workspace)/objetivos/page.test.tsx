import type {
  ContributionAllowance,
  ContributionPlan,
  FireScopeConfig,
  InvestmentOperation,
  Liability,
  ManualAsset,
  PayoutSchedule,
  Workspace,
} from "@worthline/domain";
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
  const assets: ManualAsset[] = [
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
  const liabilities: Liability[] = [
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
    readCurveValuedHoldingsAtDate: vi.fn(
      async (): Promise<{ assets: ManualAsset[]; liabilities: Liability[] }> => ({
        assets,
        liabilities,
      }),
    ),
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
    readPayoutSchedules: vi.fn(async (): Promise<PayoutSchedule[]> => []),
    readWarningOverrides: vi.fn(async () => []),
    readContributionPlan: vi.fn(
      async (): Promise<ContributionPlan> => ({
        scopeId: "household",
        contributions: [],
      }),
    ),
    readContributionReconciliations: vi.fn(async () => []),
    readContributionAllowances: vi.fn(async (): Promise<ContributionAllowance[]> => []),
    readOperations: vi.fn(async () => []),
    readAllPriceCacheEntries: vi.fn(async () => []),
    readInvestmentAssetsWithMeta: vi.fn(async () => []),
    readExposureProfiles: vi.fn(async () => []),
    readSnapshotHoldings: vi.fn(async () => []),
    readWorkspace: vi.fn(
      async (): Promise<Workspace> => ({
        baseCurrency: "EUR",
        groups: [],
        members: [{ id: "member_jose", name: "Jose" }],
        mode: "individual",
      }),
    ),
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
          contributionAllowances: {
            readContributionAllowances: calls.readContributionAllowances,
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

/** Display money as the app writes it (whole euros, es-ES). */
const euros = (amountMinor: number) =>
  formatMoneyMinorPrivacy({ amountMinor, currency: "EUR" }, false);

/** The «¿De dónde salen estos años?» fold — where every projection input is printed. */
function assumptionsFold(html: string): string {
  const opened = html.slice(html.indexOf('<details class="fireAssumptions"'));
  return opened.slice(0, opened.indexOf("</details>"));
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
  function landlordLedger(): { assets: ManualAsset[]; liabilities: Liability[] } {
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
    expect(html).toContain(
      '<p class="fireBig">66,4 % <span class="fireBigNoun">financiado</span></p>',
    );
    // … but only 153.927,33 / 685.714,29 = 22,4 % of it can be spent in
    // instalments. That caveat lives inside «¿Qué cuenta como activo elegible?»,
    // not in the hero: #1447 splits the capital, it does not restate the %.
    const disclosure = html.slice(html.indexOf('<details class="fireEligibleNote"'));
    expect(disclosure.slice(0, disclosure.indexOf("</details>"))).toContain("22,4 %");
  });

  // #1460: la misma cartera, con el usuario declarando que no piensa vender el piso.
  test("measures only the sellable side when the user declared the brick out", async () => {
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce(landlordLedger());
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        immobilizedCountsAsFireCapital: false,
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.035,
        expectedRealReturn: 0.05,
      },
    });

    const html = await renderedHtml();

    // El 22,4 % que antes era una nota al pie ahora ES el titular.
    expect(html).toContain(
      '<p class="fireBig">22,4 % <span class="fireBigNoun">financiado</span></p>',
    );
    expect(html).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 153_927_33, currency: "EUR" }, false),
    );
    // El ladrillo no desaparece: sigue impreso, apagado y dicho.
    expect(html).toContain("is-outOfCalculation");
    expect(html).toContain("fuera del cálculo");
    expect(html).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 301_371_97, currency: "EUR" }, false),
    );
    // Y no se pintan dos porcentajes de lo mismo.
    expect(html).not.toContain("Solo con lo vendible estarías al");
  });

  test("stays out of the way when nothing in the pool is immobilized", async () => {
    const html = await renderedHtml();

    // La palabra sí aparece: la casilla de #1460 pregunta por el inmovilizado en el
    // formulario de supuestos, tenga el usuario ladrillo o no. Lo que no puede
    // aparecer es el DESGLOSE, que es lo que este test vigila.
    expect(html).not.toContain("Desglose de los activos elegibles");
    expect(html).not.toContain("no se gasta a plazos");
  });
});

describe("ObjetivosPage auditable FIRE figures (#1426)", () => {
  /** Jorge's config: 2.000 €/mes at 3,5 %, with an age so Coast exists. */
  function jorgeConfig(overrides: Partial<FireScopeConfig> = {}): FireScopeConfig {
    return {
      currentAge: 63,
      monthlySavingsCapacityMinor: 10_000,
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.035,
      targetRetirementAge: 67,
      ...overrides,
    };
  }

  test("prints the division the FIRE number came from, beside the number", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: jorgeConfig() });

    const html = await renderedHtml();

    // 2.000 €/mes × 12 ÷ 3,5 % — the arithmetic that was nowhere on screen.
    const formula = html.slice(html.indexOf('<p class="fireFormula">'));
    expect(formula.slice(0, formula.indexOf("</p>"))).toContain(
      `${euros(24_000_00)}/año de gasto</a> ÷ <a href="#supuestos">3,5 % de retirada</a> = <strong>${euros(
        685_714_29,
      )}</strong>`,
    );
    // Both inputs are the user's own, so they link to where they are edited —
    // which since #1450 is the assumptions form on this same screen.
    expect(formula).toContain('<a href="#supuestos">');
  });

  test("gives the funded percentage a noun and the fraction behind it", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: jorgeConfig() });

    const html = await renderedHtml();

    expect(html).toContain('<span class="fireBigNoun">financiado</span>');
    // 50.000 € of 685.714 €: the two amounts, not just the ratio.
    expect(html).toContain(
      `<p class="fireFundedFraction">${euros(50_000_00)} de ${euros(685_714_29)}</p>`,
    );
  });

  test("measures progress toward Coast, not the tick's position on the bar", async () => {
    // Con una tasa que componga: sin margen de composición hasta la edad objetivo no
    // hay Coast del que medir progreso (#1425, ADR 0079), y el pool de este fixture es
    // todo caja al 0 %.
    calls.readFireConfig.mockResolvedValueOnce({
      household: jorgeConfig({ expectedRealReturn: 0.05 }),
    });

    const html = await renderedHtml();

    expect(html).toContain("Hacia Coast llevas");
    // The chain reaches Coast too: the requirement carries the discount behind it,
    // and the percentage carries its two amounts.
    expect(html).toContain("tu número FIRE descontado 4 años al");
    expect(html).toContain('class="fireFundedFraction fireFundedFraction--coast"');
    // The old copy described the tick («el 84,2 % de tu número FIRE»), which is a
    // property of the tick and not of anyone's progress.
    expect(html).not.toContain("% de tu número\nFIRE)");
  });

  test("opens the projection's assumptions, weighted return included", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: jorgeConfig() });

    const fold = assumptionsFold(await renderedHtml());

    expect(fold).toContain("Objetivo de gasto");
    expect(fold).toContain("Tasa de retirada");
    expect(fold).toContain("Aportación");
    expect(fold).toContain("Rentabilidad optimista");
    expect(fold).toContain("Edad actual / objetivo");
    // The tier table: the cash rung is the whole eligible pool here, at 0 %.
    expect(fold).toContain("Caja");
    expect(fold).toContain("<td>100,00 %</td>");
  });

  test("cites the birth year behind the age instead of showing a typed-looking one", async () => {
    calls.readWorkspace.mockResolvedValueOnce({
      baseCurrency: "EUR",
      groups: [],
      members: [{ birthYear: 1963, id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    calls.readFireConfig.mockResolvedValueOnce({ household: jorgeConfig() });

    expect(assumptionsFold(await renderedHtml())).toContain(
      "tu edad sale de tu año de nacimiento (1963)",
    );
  });

  test("says what each FIRE level funds per year, and the multipliers behind them", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: jorgeConfig() });

    const html = await renderedHtml();

    // Lean is 70 % of the spending: 16.800 €/año.
    expect(html).toContain(`financia ${euros(16_800_00)}/año`);
    expect(html).toContain("<strong>Lean</strong> es tu gasto al 70 %");
    expect(html).toContain("<strong>Fat</strong> es tu gasto al 150 %");
    // Coast is not a multiple of spending, so its card claims no annual figure: it is
    // the capital meant to be left alone.
    expect(html).not.toContain("financia 685.714");
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
  function ledgerHoldings(): { assets: ManualAsset[]; liabilities: Liability[] } {
    const fondo: ManualAsset = {
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

// ── the declared rent inside the expected return (#1448) ─────────────────────

describe("ObjetivosPage rent-derived real return (#1448)", () => {
  const TODAY = new Date().toISOString().slice(0, 10);

  /** A rented flat plus the cash rung, so the housing weight is not 100 %. */
  function withRentedFlat(
    expensesMinor?: number,
    fireConfig: FireScopeConfig = {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
    },
  ) {
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce({
      assets: [
        {
          id: "asset_flat",
          name: "Piso Navalcarnero",
          type: "real_estate",
          instrument: "property",
          currency: "EUR",
          currentValue: { amountMinor: 200_000_00, currency: "EUR" },
          liquidityTier: "illiquid",
          ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
          isPrimaryResidence: false,
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
      ],
      liabilities: [],
    });
    calls.readPayoutSchedules.mockResolvedValueOnce([
      {
        id: "sch_rent",
        holdingId: "asset_flat",
        label: "Alquiler",
        amountMinor: 100_000,
        cadence: "monthly",
        startISO: "2024-01-01",
        endISO: null,
        exclusions: [],
        ...(expensesMinor === undefined ? {} : { expensesMinor }),
      },
    ]);
    // Queued per test (never `mockReset`, which would strip the shared default
    // implementation for every test that runs after this one).
    calls.readFireConfig.mockResolvedValueOnce({ household: fireConfig });
  }

  test("a declared net rent becomes the flat's own real return on screen", async () => {
    // 1.000 €/mes − 250 €/mes = 9.000 €/año over 200.000 € → 4,5 %.
    withRentedFlat(25_000);

    const html = await renderedHtml();

    expect(html).toContain("Alquiler declarado en la rentabilidad");
    expect(html).toContain("Piso Navalcarnero · 4,5 % real");
    // The weighted portfolio rate follows: 2/3 at 4,5 % + 1/3 at 0 % (cash) = 3 %.
    // It lives in the assumptions fold now (#1426), with its weights beside it.
    const fold = assumptionsFold(html);
    expect(fold).toContain("<strong>3,0 %</strong>");
    expect(fold).toContain("ponderada por tu mezcla de activos");
  });

  test("a rent with no declared costs is withheld out loud, gross figure included", async () => {
    withRentedFlat();

    const html = await renderedHtml();

    expect(html).toContain("falta declarar sus gastos");
    // 12.000 €/año over 200.000 € = 6 % gross, named as what is NOT being used.
    expect(html).toContain("6,0 %");
    // The rate stays the housing default: 2/3 × 3 % = 2 %.
    expect(assumptionsFold(html)).toContain("<strong>2,0 %</strong>");
  });

  test("with a manual return configured the section stays away", async () => {
    withRentedFlat(25_000, {
      expectedRealReturn: 0.05,
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
    });

    const html = await renderedHtml();

    expect(html).not.toContain("Alquiler declarado en la rentabilidad");
    // A manual rate has no weighting to show, so the fold says where it came from
    // and the tier table stays away (it would explain a rate nothing used).
    expect(assumptionsFold(html)).toContain("fijada a mano en tus supuestos");
    expect(html).not.toContain("fireMixTable");
  });

  test("an ended rent does not feed the rate, and the row says so", async () => {
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce({
      assets: [
        {
          id: "asset_flat",
          name: "Piso Casarrubios",
          type: "real_estate",
          instrument: "property",
          currency: "EUR",
          currentValue: { amountMinor: 200_000_00, currency: "EUR" },
          liquidityTier: "illiquid",
          ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
          isPrimaryResidence: false,
        },
      ],
      liabilities: [],
    });
    calls.readPayoutSchedules.mockResolvedValueOnce([
      {
        id: "sch_rent",
        holdingId: "asset_flat",
        label: "Alquiler",
        amountMinor: 100_000,
        expensesMinor: 25_000,
        cadence: "monthly",
        startISO: "2020-01-01",
        // Ended yesterday relative to the page's own clock.
        endISO: new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
          .toISOString()
          .slice(0, 10),
        exclusions: [],
      },
    ]);
    calls.readFireConfig.mockResolvedValueOnce({
      household: { monthlySpendingMinor: 200_000, safeWithdrawalRate: 0.04 },
    });

    const html = await renderedHtml();

    expect(html).toContain("no está vigente hoy");
    expect(assumptionsFold(html)).toContain("<strong>3,0 %</strong>");
  });
});

describe("los supuestos FIRE se editan donde se ven (#1450)", () => {
  test("el formulario mudado vive aquí, entero y con su acción de guardado", async () => {
    const html = await renderedHtml();

    expect(html).toContain("Tus supuestos");
    for (const field of [
      'name="monthlySpending"',
      'name="safeWithdrawalRate"',
      'name="monthlySavingsCapacity"',
      'name="targetRetirementAge"',
    ]) {
      expect(html).toContain(field);
    }
    expect(html).toContain("Guardar supuestos");
    // El scope viaja con el formulario: la config es por ámbito.
    expect(html).toContain('name="scopeId"');
  });

  test("los supuestos finos viajan también: guardar no puede borrarlos", async () => {
    // El parser reconstruye la config entera desde el formulario, así que un campo
    // que no se pinta se pierde en el siguiente guardado.
    const html = await renderedHtml();

    for (const field of [
      'name="expectedRealReturn"',
      'name="tierReturn_cash"',
      'name="tierReturn_market"',
      'name="tierReturn_term-locked"',
      'name="tierReturn_illiquid"',
      'name="leanMultiplier"',
      'name="fatMultiplier"',
      'name="baristaIncome"',
    ]) {
      expect(html).toContain(field);
    }
  });

  test("cada campo editable dice qué mueve, no qué es", async () => {
    const html = await renderedHtml();

    expect(html).toContain("Define tu número FIRE: gasto anual ÷ tasa de retirada");
    expect(html).toContain("Más baja = más prudente = número FIRE más alto");
    expect(html).toContain("marca la velocidad a la que llegas, no el objetivo");
    expect(html).toContain("Fija el Coast");
  });

  test("la edad y el retorno se leen con su procedencia, no se teclean", async () => {
    const html = await renderedHtml();

    expect(html).not.toContain('name="currentAge"');
    expect(html).toContain("Edad actual");
    // El miembro del mock no tiene año de nacimiento: sin él no hay edad, y sin
    // edad calculateFire se salta el bloque de coast sin decir nada.
    expect(html).toContain("Sin fecha de nacimiento no hay edad actual");
    // La config del mock fija el retorno a mano, y la fila lo declara.
    expect(html).toContain("5,0 % (fijado a mano)");
  });

  test("una edad heredada de la configuración vieja se declara congelada", async () => {
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        currentAge: 48,
        excludedAssetIds: [],
      },
    });

    const html = await renderedHtml();

    expect(html).toContain("48 años");
    expect(html).toContain("no se actualiza sola");
  });

  test("el ahorro sembrado por la migración sigue pidiendo revisión (#1416)", async () => {
    calls.readFireConfig.mockResolvedValueOnce({
      household: {
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
        monthlySavingsCapacityMinor: 10_000,
        monthlySavingsCapacitySeededFromPlan: true,
        excludedAssetIds: [],
      },
    });

    const html = await renderedHtml();

    expect(html).toContain("Hemos puesto este ahorro mensual con el total de tu plan");
    expect(html).toContain("Es la única cifra de ahorro que usa la proyección FIRE");
  });

  test("ya no manda a Ajustes a configurar: los enlaces apuntan al formulario de al lado", async () => {
    const html = await renderedHtml();

    expect(html).not.toContain("Configurar FIRE → Ajustes");
    expect(html).not.toContain("Los supuestos de tu FIRE");
    expect(html).toContain('href="#supuestos"');
    expect(html).toContain('id="supuestos"');
  });

  test("un error sin formulario propio se pinta: el guardado no puede rebotar en silencio", async () => {
    // El guard de la demo y un scope inexistente redirigen con un error sin
    // `formId`. Antes de la mudanza esa banda existía en /ajustes; aquí no, así
    // que la acción volvía sin decir nada.
    const html = await renderedHtml({
      error: "Acción deshabilitada en la demo — datos ficticios de solo lectura.",
    });

    expect(html).toContain("errorBand");
    expect(html).toContain("deshabilitada en la demo");
  });

  test("sin config el vacío pide rellenar aquí, no viajar a otra pantalla", async () => {
    calls.readFireConfig.mockResolvedValueOnce({});

    const html = await renderedHtml();

    expect(html).toContain("Rellena tus supuestos aquí al lado");
    expect(html).toContain("Rellenar mis supuestos");
    // Y el formulario está presente para poder hacerlo.
    expect(html).toContain('name="monthlySpending"');
  });
});

describe("ObjetivosPage la palabra Coast significa UNA cosa (#1425)", () => {
  /** Jorge: 63 años, jubilación a 67, 2.000 €/mes al 3,5 %. */
  function coastConfig(overrides: Partial<FireScopeConfig> = {}): FireScopeConfig {
    return {
      currentAge: 63,
      monthlySavingsCapacityMinor: 250_000,
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.035,
      expectedRealReturn: 0.05,
      targetRetirementAge: 67,
      ...overrides,
    };
  }

  /** El bloque de Coast: sus cuatro cifras viven juntas, junto a la barra. */
  function coastBlock(html: string): string {
    const opened = html.slice(html.indexOf('<section aria-label="Coast FIRE"'));
    return opened.slice(0, opened.indexOf("</section>"));
  }

  test("fecha la llegada a Coast con las aportaciones declaradas", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: coastConfig() });

    const block = coastBlock(await renderedHtml());

    // La cifra que el tick prometía desde PRD #507 y que no se calculaba en ningún
    // sitio: el primer año en que la trayectoria CON aportaciones cruza el requisito.
    expect(block).toContain("Llegas a Coast");
    expect(block).toMatch(/<strong>a los \d+<\/strong>/);
    expect(block).toContain("con tus aportaciones");
  });

  test("las edades van a año entero: 72,99 se imprimía «73,0» y parecía roto", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: coastConfig() });

    const block = coastBlock(await renderedHtml());

    // Ni una coma decimal en ninguna de las dos edades.
    expect(block).not.toMatch(/a los \d+,\d/);
  });

  test("la vieja «Edad Coast» lleva su premisa por nombre", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: coastConfig() });

    const html = await renderedHtml();

    // Es la edad a la que se llega al número FIRE COMPLETO dejando de aportar hoy —
    // otra pregunta que la de arriba, y por eso ya no comparte prefijo con ella.
    expect(html).not.toContain("Edad Coast");
    expect(coastBlock(html)).toContain("Si dejas de aportar hoy");
    expect(coastBlock(html)).toMatch(/<strong>FIRE a los \d+<\/strong>/);
    expect(coastBlock(html)).toContain("sin aportar un euro más");
  });

  test("admite que con el ahorro declarado no se cruza el Coast", async () => {
    // 0,1 % real y 100 €/mes sobre un requisito de ~684.000 €: no llega, y lo dice en
    // vez de callarse o inventar una fecha.
    calls.readFireConfig.mockResolvedValueOnce({
      household: coastConfig({
        expectedRealReturn: 0.001,
        monthlySavingsCapacityMinor: 10_000,
      }),
    });

    const block = coastBlock(await renderedHtml());

    expect(block).toContain("Llegas a Coast");
    expect(block).toContain("no lo cruzas dentro de la proyección");
  });

  test("sin margen de composición no hay bloque de Coast, y el hueco dice por qué", async () => {
    // Retorno 0: el «requisito» saldría igual al número FIRE y la promesa de que el
    // interés compuesto hace el resto sería falsa (ADR 0079).
    calls.readFireConfig.mockResolvedValueOnce({
      household: coastConfig({ expectedRealReturn: 0 }),
    });

    const html = await renderedHtml();

    expect(html).not.toContain('<section aria-label="Coast FIRE"');
    expect(html).toContain("No hay Coast que calcular");
    expect(html).toContain("el capital no crece solo");
  });

  test("tampoco lo hay con la edad objetivo ya pasada — y ahí la razón es otra", async () => {
    // El caso que no pide config exótica: 70 años con la edad objetivo por defecto (65).
    // El requisito saldría POR ENCIMA del número FIRE, o sea «llegas a Coast después de
    // llegar a FIRE».
    calls.readFireConfig.mockResolvedValueOnce({
      household: coastConfig({ currentAge: 70, targetRetirementAge: 65 }),
    });

    const html = await renderedHtml();

    expect(html).not.toContain('<section aria-label="Coast FIRE"');
    expect(html).toContain("tu edad objetivo ya ha llegado");
  });

  test("Coast se baja del rail de niveles, y con él el párrafo que lo desmentía", async () => {
    calls.readFireConfig.mockResolvedValueOnce({ household: coastConfig() });

    const html = await renderedHtml();
    const rail = html.slice(html.indexOf('<section aria-label="Niveles FIRE"'));
    const levels = rail.slice(0, rail.indexOf("</section>"));

    // El rail responde a UNA pregunta: qué nivel de vida quiero financiar.
    expect(levels).toContain("Lean");
    expect(levels).toContain("Regular");
    expect(levels).toContain("Fat");
    expect(levels).not.toContain("Coast");
  });
});

describe("ObjetivosPage cupo anual de aportación (#1427)", () => {
  const pensionPlan: ManualAsset = {
    currency: "EUR",
    currentValue: { amountMinor: 20_000_00, currency: "EUR" },
    id: "asset_pp",
    isPrimaryResidence: false,
    liquidityTier: "term-locked",
    name: "MyInvestor Value PP",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
  };

  /** Put a pension plan with a ledger on the page for one render. */
  function withPensionPlan(operations: InvestmentOperation[]): void {
    calls.readCurveValuedHoldingsAtDate.mockResolvedValueOnce({
      assets: [pensionPlan],
      liabilities: [],
    });
    calls.buildProjectionContext.mockResolvedValueOnce({
      ...calls.projectionContext,
      operationsByAsset: new Map([["asset_pp", operations]]),
    });
  }

  function contribution(
    id: string,
    executedAt: string,
    units: string,
  ): InvestmentOperation {
    return {
      assetId: "asset_pp",
      currency: "EUR",
      executedAt,
      feesMinor: 0,
      id,
      kind: "buy",
      pricePerUnit: "100",
      units,
    };
  }

  const cupo: ContributionAllowance = {
    annualCapMinor: 1_500_00,
    holdingIds: ["asset_pp"],
    id: "cupo_pp",
    label: "Planes de pensiones",
    scopeId: "household",
  };

  test("el caso de Jorge: «llevo 1.300 € de los 1.500 posibles»", async () => {
    calls.readContributionAllowances.mockResolvedValueOnce([cupo]);
    withPensionPlan([
      contribution("op_1", "2026-02-10", "10"),
      contribution("op_2", "2026-05-10", "3"),
    ]);

    const html = await renderedHtml();

    expect(html).toContain("Cupo anual de aportación");
    expect(html).toContain(euros(1_300_00));
    expect(html).toContain(euros(1_500_00));
    expect(html).toContain(`quedan ${euros(200_00)}`);
  });

  test("no cuenta lo aportado en otro año natural", async () => {
    calls.readContributionAllowances.mockResolvedValueOnce([cupo]);
    withPensionPlan([
      contribution("op_old", "2025-12-31", "10"),
      contribution("op_now", "2026-03-01", "3"),
    ]);

    const html = await renderedHtml();

    expect(html).toContain(`quedan ${euros(1_200_00)}`);
  });

  test("pasarse del tope se dice con palabras, no solo con color", async () => {
    calls.readContributionAllowances.mockResolvedValueOnce([cupo]);
    withPensionPlan([contribution("op_1", "2026-02-10", "18")]);

    const html = await renderedHtml();

    expect(html).toContain(`te has pasado ${euros(300_00)}`);
    expect(html).toContain("objetivosCupoRemainder exceeded");
  });

  test("cada cifra se puede desplegar hasta las operaciones que la componen", async () => {
    calls.readContributionAllowances.mockResolvedValueOnce([cupo]);
    withPensionPlan([contribution("op_1", "2026-02-10", "10")]);

    const html = await renderedHtml();

    expect(html).toContain("Ver la aportación contada");
    expect(html).toContain("10 feb 2026");
    expect(html).toContain("MyInvestor Value PP");
  });

  test("sin cupos definidos explica qué es uno y ofrece crearlo", async () => {
    withPensionPlan([]);

    const html = await renderedHtml();

    expect(html).toContain("Aún no has definido ningún cupo");
    expect(html).toContain("allowanceCreateForm");
    expect(html).toContain("Tope anual de aportación");
  });

  test("el tope es dato del usuario, y la pantalla lo dice", async () => {
    withPensionPlan([]);

    const html = await renderedHtml();

    expect(html).toContain("worthline no calcula límites fiscales");
  });

  test("solo ofrece como destino activos con libro de operaciones", async () => {
    // La lista por defecto de la página es una casa y una cuenta: ninguna registra
    // aportaciones una a una, así que un cupo sobre ellas contaría 0 y mentiría.
    const html = await renderedHtml();

    expect(html).toContain("necesita al menos una inversión con libro de operaciones");
  });
});
