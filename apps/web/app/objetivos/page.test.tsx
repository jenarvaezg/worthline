import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => {
  const projectionContext = {};
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
    readWorkspace: vi.fn(async () => ({
      baseCurrency: "EUR",
      groups: [],
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    })),
    withStore: vi.fn(async (run: (store: unknown) => unknown) =>
      run({
        assets: { readAssets: calls.readAssets },
        goals: { readGoals: calls.readGoals },
        payouts: {
          readPayouts: calls.readPayouts,
          readPayoutSchedules: calls.readPayoutSchedules,
        },
        readFireConfig: calls.readFireConfig,
        readWarningOverrides: calls.readWarningOverrides,
        snapshots: {
          buildProjectionContext: calls.buildProjectionContext,
          readCurveValuedHoldingsAtDate: calls.readCurveValuedHoldingsAtDate,
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

import ObjetivosPage from "./page";

async function renderedHtml(): Promise<string> {
  const element = (await ObjetivosPage({
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

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
