import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  debtBalanceAtDate: vi.fn(async () => 174_500_00),
  readAmortizationPlan: vi.fn(async (): Promise<unknown> => null),
  readAssets: vi.fn(async () => []),
  readBalanceAnchors: vi.fn(async (): Promise<unknown[]> => []),
  readBalanceRebaselines: vi.fn(async (): Promise<unknown[]> => []),
  readDebtModel: vi.fn(async () => "amortizable"),
  readEarlyRepayments: vi.fn(async () => []),
  readInterestRateRevisions: vi.fn(async () => []),
  readPublicIds: vi.fn(async () => [
    {
      entityId: "liability_mortgage",
      entityType: "holding" as const,
      publicId: "wl_hld_mortgage",
    },
  ]),
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
        agentView: { readPublicIds: calls.readPublicIds },
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

/**
 * The route addresses the holding by its public `wl_hld_…` id (#1318) — the same
 * id the agent view and the MCP take. `liability_mortgage` is the internal
 * storage id it resolves to.
 */
const PUBLIC_ID = "wl_hld_mortgage";

async function renderedHtml(
  routeId: string = PUBLIC_ID,
  searchParams: Record<string, string> = {},
): Promise<string> {
  const element = (await EditarPage({
    params: Promise.resolve({ id: routeId }),
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe("EditarPage — one id vocabulary (#1318)", () => {
  test("the ficha is addressed by the holding's public id, and links back with it", async () => {
    const html = await renderedHtml();

    // Every URL the page emits — the return-here field every form posts, and the
    // «Volver» anchor — names the holding by its public id.
    expect(html).toContain(`value="/patrimonio/${PUBLIC_ID}/editar"`);
    expect(html).toContain(`href="/patrimonio#${PUBLIC_ID}"`);
    // …and never by the internal storage id, which is what the assistant used to
    // read out of the URL bar and hand to tools that reject it.
    expect(html).not.toContain("/patrimonio/liability_mortgage/editar");
    expect(html).not.toContain("/patrimonio#liability_mortgage");
    // It still travels as the hidden form id: storage plumbing, not a URL.
    expect(html).toContain('value="liability_mortgage"');
  });

  test("a mutation's ok band still lands on the public URL", async () => {
    // Every debt/housing action now returns to the `currentUrl` the form posted
    // instead of rebuilding the path from the storage id, so the success band
    // has to survive that swap — it is the only thing the user sees confirming
    // the write.
    const html = await renderedHtml(PUBLIC_ID, { ok: "debt_model_saved" });

    expect(html).toContain('role="status"');
    expect(html).toContain("Modelo de deuda guardado.");
  });

  test("the internal storage id is not a route — it is a 404, not a second door", async () => {
    await expect(renderedHtml("liability_mortgage")).rejects.toThrow();
  });

  test("a public id nobody owns is a 404", async () => {
    await expect(renderedHtml("wl_hld_doesnotexist")).rejects.toThrow();
  });
});

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

  /**
   * The danger zone's "registrar la venta" link (#1365) points back at this ficha
   * with `?abrir=operaciones`. The operations surface lives inside the collapsed
   * advanced block, so a bare `#operaciones` fragment would scroll to something
   * `display:none` and reveal nothing — the param has to unfold it server-side.
   */
  test("?abrir=operaciones unfolds the advanced block on load", async () => {
    expect(await renderedHtml(PUBLIC_ID, { abrir: "operaciones" })).toContain(
      '<details class="editAdvanced" open=""',
    );
    expect(await renderedHtml()).not.toContain('class="editAdvanced" open=""');
  });

  test("?abrir=cobros unfolds the advanced block on load", async () => {
    expect(await renderedHtml(PUBLIC_ID, { abrir: "cobros" })).toContain(
      '<details class="editAdvanced" open=""',
    );
  });
});

/**
 * A debt with a modelled curve takes its figure from the curve; the raw
 * `current_balance_minor` form is then a write into the void (#1290).
 */
describe("EditarPage — the raw balance door follows the engine (#1290)", () => {
  // The modelled figure below is a function of TODAY: every cuota the plan pays
  // moves it. Left on the real clock this test passed for one month and then
  // started failing on the 21st, when the second cuota fell. Freezing the day is
  // what makes the pinned figure mean "the plan produces this", not "the calendar
  // happens to agree".
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

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
