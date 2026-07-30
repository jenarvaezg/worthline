import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  debtBalanceAtDate: vi.fn(async () => 174_500_00),
  readAmortizationPlan: vi.fn(async (): Promise<unknown> => null),
  readAssets: vi.fn(async () => []),
  readBalanceAnchors: vi.fn(async (): Promise<unknown[]> => []),
  readBalanceRebaselines: vi.fn(async (): Promise<unknown[]> => []),
  readDebtModel: vi.fn(async () => "amortizable"),
  readEarlyRepayments: vi.fn(async () => []),
  readInterestRateRevisions: vi.fn(async () => []),
  readLiabilities: vi.fn(async () => [
    {
      currency: "EUR",
      currentBalance: { amountMinor: 180_000_00, currency: "EUR" },
      id: "liability_mortgage",
      name: "Hipoteca",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "mortgage",
    },
  ]),
  readValuationCadence: vi.fn(async () => null),
  readWarningOverrides: vi.fn(async () => []),
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
        checkedAt: "2026-07-07T00:00:00.000Z",
        checkKey: "bootstrap.last_healthcheck_at",
        checkValue: "2026-07-07T00:00:00.000Z",
        databasePath: ":memory:",
        displayPath: ":memory:",
        status: "ok",
      },
      privacyMode: false,
      requestedScopeId: undefined,
      scopes,
      selectedScope: scopes[0],
      store: {
        assets: { readAssets: calls.readAssets },
        liabilities: {
          debtBalanceAtDate: calls.debtBalanceAtDate,
          readAmortizationPlan: calls.readAmortizationPlan,
          readBalanceAnchors: calls.readBalanceAnchors,
          readBalanceRebaselines: calls.readBalanceRebaselines,
          readDebtModel: calls.readDebtModel,
          readEarlyRepayments: calls.readEarlyRepayments,
          readInterestRateRevisions: calls.readInterestRateRevisions,
          readLiabilities: calls.readLiabilities,
          readValuationCadence: calls.readValuationCadence,
        },
        readWarningOverrides: calls.readWarningOverrides,
      },
      target: { kind: "local" },
      workspace: await calls.readWorkspace(),
    };
  }),
}));

vi.mock("@web/page-shell", () => ({
  resolvePageShell: calls.resolvePageShell,
}));

vi.mock("@web/demo/write-guard", () => ({ isDemoMode: async () => false }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

import EditarPage from "./page";

async function renderedHtml(): Promise<string> {
  const element = (await EditarPage({
    params: Promise.resolve({ id: "liability_mortgage" }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe("EditarPage progressive disclosure (#604)", () => {
  test("keeps mortgage basics open, machinery collapsed, and danger last", async () => {
    const html = await renderedHtml();
    const basic = html.indexOf("Lo básico");
    const balance = html.indexOf("Saldo pendiente");
    const advanced = html.indexOf("Configuración avanzada");
    const model = html.indexOf("Modelo de deuda");
    const danger = html.indexOf("Zona de peligro");

    expect(basic).toBeGreaterThan(-1);
    expect(balance).toBeGreaterThan(basic);
    expect(advanced).toBeGreaterThan(balance);
    expect(model).toBeGreaterThan(advanced);
    expect(danger).toBeGreaterThan(model);
    expect(html).toContain("<summary>Configuración avanzada</summary>");

    const basicMarkup = html.slice(basic, advanced);
    expect(basicMarkup.match(/<form/g)?.length).toBe(2);
  });
});

/**
 * A debt with a modelled curve takes its figure from the curve; the raw
 * `current_balance_minor` form is then a write into the void (#1290).
 */
describe("EditarPage — the raw balance door follows the engine (#1290)", () => {
  const PLAN = {
    annualInterestRate: "0.0589",
    disbursementDate: "2026-06-21",
    firstPaymentDate: "2026-07-21",
    id: "plan_revolut",
    initialCapitalMinor: 6_000_00,
    liabilityId: "liability_mortgage",
    originalSigningDate: null,
    termMonths: 42,
  };

  test("with no plan and no re-baseline the stored balance is the only figure", async () => {
    calls.readAmortizationPlan.mockResolvedValueOnce(null);
    calls.readBalanceRebaselines.mockResolvedValueOnce([]);
    const html = await renderedHtml();

    expect(html).toContain("Saldo pendiente (EUR)");
    expect(html).toContain('name="balance"');
    expect(html).toContain("Actualizar saldo");
  });

  test("an amortizable debt with a plan exposes no raw balance form", async () => {
    calls.readAmortizationPlan.mockResolvedValueOnce(PLAN);
    calls.readBalanceRebaselines.mockResolvedValueOnce([]);
    const html = await renderedHtml();

    // "Saldo pendiente hoy" (the current-state form) is a different door; what
    // must be gone is the raw `current_balance_minor` input and its submit.
    expect(html).not.toContain("Saldo pendiente (EUR)");
    expect(html).not.toContain('name="balance"');
    expect(html).not.toContain("Actualizar saldo");
    // The modelled figure is the one on screen, and it is not the stored 180.000.
    // Since #1292 the page derives it from the rows it already read instead of
    // asking the store again, so this pins the figure the PLAN actually produces
    // (6.000 € at 5,89 % closes its first cuota at 5.871,01 €) rather than
    // whatever the store stub was told to return.
    expect(html).toContain("Saldo modelado a día de hoy");
    expect(html).toContain("5871");
    expect(html).not.toContain("180.000");
  });

  test("an anchored debt with at least one anchor exposes no raw balance form", async () => {
    calls.readDebtModel.mockResolvedValueOnce("informal");
    calls.readBalanceAnchors.mockResolvedValueOnce([
      {
        anchorDate: "2026-07-01",
        balanceMinor: 9_000_00,
        id: "anchor_1",
        liabilityId: "liability_mortgage",
      },
    ]);
    const html = await renderedHtml();

    // `name="balance"` is not discriminating here — the anchor form uses it too;
    // the raw door is identified by its label + submit.
    expect(html).not.toContain("Saldo pendiente (EUR)");
    expect(html).not.toContain("Actualizar saldo");
    // The declared balances are the figure on screen for an anchored debt.
    expect(html).toContain("Saldos declarados");
  });

  test("an anchored debt with no anchors yet keeps the raw balance form", async () => {
    calls.readDebtModel.mockResolvedValueOnce("informal");
    calls.readBalanceAnchors.mockResolvedValueOnce([]);
    const html = await renderedHtml();

    expect(html).toContain("Saldo pendiente (EUR)");
    expect(html).toContain("Actualizar saldo");
  });

  test("a re-baseline alone (no plan row) also retires the raw balance form", async () => {
    calls.readAmortizationPlan.mockResolvedValueOnce(null);
    calls.readBalanceRebaselines.mockResolvedValueOnce([
      {
        annualInterestRate: "0.0589",
        baselineDate: "2026-06-21",
        endDate: "2029-12-21",
        id: "rebaseline_1",
        liabilityId: "liability_mortgage",
        nextPaymentDate: "2026-07-21",
        outstandingBalanceMinor: 6_000_00,
        startsAtBaseline: true,
      },
    ]);
    const html = await renderedHtml();

    expect(html).not.toContain("Saldo pendiente (EUR)");
    expect(html).not.toContain('name="balance"');
    expect(html).toContain("Saldo modelado a día de hoy");
  });
});
