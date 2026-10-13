import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/** The URL the island reads through `useSearchParams` — set per render. */
const url = vi.hoisted(() => ({ search: new URLSearchParams() }));

const calls = vi.hoisted(() => ({
  debtBalanceAtDate: vi.fn(async () => 174_500_00),
  readAmortizationPlan: vi.fn(async (): Promise<unknown> => null),
  readAssets: vi.fn(async () => []),
  readBalanceAnchors: vi.fn(async (): Promise<unknown[]> => []),
  readBalanceRebaselines: vi.fn(async (): Promise<unknown[]> => []),
  readDebtModel: vi.fn(async (): Promise<string | null> => "amortizable"),
  readEarlyRepayments: vi.fn(async (): Promise<unknown[]> => []),
  readInterestRateRevisions: vi.fn(async (): Promise<unknown[]> => []),
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
  redirect: (to: string) => {
    throw new Error(`redirected to ${to}`);
  },
  useSearchParams: () => url.search,
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
const FICHA = `/patrimonio/${PUBLIC_ID}/editar`;

async function renderedHtml(
  routeId: string = PUBLIC_ID,
  searchParams: Record<string, string> = {},
): Promise<string> {
  url.search = new URLSearchParams(searchParams);
  const element = (await EditarPage({
    params: Promise.resolve({ id: routeId }),
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

/** The markup of the tab on show (up to the panel), and of the side panel. */
const tabBody = (html: string) => {
  const panelAt = html.indexOf('class="fichaPanel"');
  return html.slice(
    html.indexOf('class="fichaTabBody"'),
    panelAt === -1 ? undefined : panelAt,
  );
};
const panel = (html: string) => {
  const at = html.indexOf('class="fichaPanel"');
  return at === -1 ? "" : html.slice(at);
};
const bar = (html: string) =>
  html.slice(
    html.indexOf('aria-label="Acciones de la deuda"'),
    html.indexOf('class="fichaFigures"'),
  );
/** The state header: the value, the bar and the figures. */
const header = (html: string) =>
  html.slice(
    html.indexOf('class="heroPanel fichaHero"'),
    html.indexOf('class="fichaTabs"'),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditarPage — one id vocabulary (#1318)", () => {
  test("the ficha is addressed by the holding's public id, and links back with it", async () => {
    const html = await renderedHtml(PUBLIC_ID, { pestaña: "datos" });

    // Every URL the page emits — the return-here field every form posts, and the
    // «← Patrimonio» anchor — names the holding by its public id.
    expect(html).toContain(`value="${FICHA}?pesta%C3%B1a=datos"`);
    expect(html).toContain(`href="/patrimonio#${PUBLIC_ID}"`);
    // …and never by the internal storage id, which is what the assistant used to
    // read out of the URL bar and hand to tools that reject it.
    expect(html).not.toContain("/patrimonio/liability_mortgage/editar");
    expect(html).not.toContain("/patrimonio#liability_mortgage");
    // It still travels as the hidden form id: storage plumbing, not a URL.
    expect(html).toContain('value="liability_mortgage"');
  });

  test("a mutation's ok notice still lands on the public URL", async () => {
    // Every debt action returns to the `currentUrl` the form posted, so the notice
    // has to survive that — it is the only thing confirming the write.
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

describe("EditarPage — a debt's ficha is a state header with tabs (#1848)", () => {
  test("no «Configuración avanzada»: its own tabs, then «Datos de la deuda»", async () => {
    const html = await renderedHtml();

    expect(html).not.toContain("Configuración avanzada");
    expect(html).toContain('aria-label="Ficha de la deuda"');
    expect(html).toContain('aria-label="Estado de la deuda"');
    expect(html).toContain('aria-label="Acciones de la deuda"');
    expect(html).not.toContain("del activo");
    const tabs = html.slice(html.indexOf('aria-label="Secciones de la ficha"'));
    expect(tabs.indexOf("Datos de la deuda")).toBeGreaterThan(tabs.indexOf("Plan"));
  });

  test("«Datos de la deuda» holds «Lo básico» and the Zona de peligro last", async () => {
    const datos = tabBody(await renderedHtml(PUBLIC_ID, { pestaña: "datos" }));

    expect(datos).toContain("Lo básico");
    expect(datos.indexOf("Zona de peligro")).toBeGreaterThan(datos.indexOf("Lo básico"));
    // The balance door left «Lo básico»: it is an action of the bar now.
    expect(datos).not.toContain("Saldo pendiente (EUR)");
  });
});

/**
 * A debt with a modelled curve takes its figure from the curve; the raw
 * `current_balance_minor` form is then a write into the void (#1290). Since #1848
 * the door is an action of the bar, offered by the same rule.
 */
describe("EditarPage — «Actualizar saldo» follows the engine (#1290, #1848)", () => {
  // The modelled figure below is a function of TODAY: every cuota the plan pays
  // moves it. Freezing the day is what makes the pinned figure mean "the plan
  // produces this", not "the calendar happens to agree".
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
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

  test("with no plan and no re-baseline the stored balance is the figure, and its door leads", async () => {
    const html = await renderedHtml();

    expect(html).toMatch(/class="fichaValue debitCol">− 180\.?000\s€/);
    expect(bar(html)).toMatch(/class="btn"[^>]*data-ficha-action="saldo-pendiente"/);

    const form = panel(await renderedHtml(PUBLIC_ID, { accion: "saldo-pendiente" }));
    expect(form).toContain('<h3 id="ficha-panel-title">Actualizar saldo</h3>');
    expect(form).toContain("Saldo pendiente (EUR)");
    expect(form).toMatch(/name="balance"[^>]*value="180\.?000,00"/);
    // A refusal returns to the ficha; so does the success (`returnTo`).
    expect(form).toContain(`name="currentUrl" value="${FICHA}"`);
    expect(form).toContain(`name="returnTo" value="${FICHA}"`);
  });

  test("a refused balance reopens the panel with what was typed, and says why once", async () => {
    const message = "El saldo de la deuda no es válido.";
    const html = await renderedHtml(PUBLIC_ID, {
      error: message,
      form: "balance",
      v_balance: "mucho",
    });

    expect(panel(html)).toContain('<h3 id="ficha-panel-title">Actualizar saldo</h3>');
    expect(panel(html)).toContain('value="mucho"');
    expect(html.split(message)).toHaveLength(2);
  });

  test("an amortizable debt with a plan offers no balance door, and heads with the plan's figure", async () => {
    calls.readAmortizationPlan.mockResolvedValueOnce(PLAN).mockResolvedValueOnce(PLAN);
    const html = await renderedHtml();

    expect(bar(html)).not.toContain("saldo-pendiente");
    expect(html).not.toContain('name="balance"');
    // The modelled figure is the one on screen, and it is not the stored 180.000:
    // 6.000 € at 5,89 % closes its first cuota at 5.871,01 €, which the board and
    // the ficha read off the same curve (#1848).
    expect(html).toMatch(/class="fichaValue debitCol">− 5\.?871\s€/);
    expect(html).not.toContain("180.000");

    // «Recalibrar» carries the same modelled figure beside the repair.
    const recalibrar = panel(await renderedHtml(PUBLIC_ID, { accion: "recalibrar" }));
    expect(recalibrar).toContain("Saldo modelado a día de hoy");
    expect(recalibrar).toContain("5871");
  });

  test("an anchored debt with at least one balance offers no balance door", async () => {
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

    expect(bar(html)).not.toContain("saldo-pendiente");
    expect(html).not.toContain("Saldo pendiente (EUR)");
    // The declared balance is the figure on screen for an anchored debt.
    expect(html).toMatch(/class="fichaValue debitCol">− 9\.?000\s€/);
    expect(tabBody(html)).toContain('aria-label="Saldos declarados"');
  });

  test("an anchored debt with no balance yet keeps the door, inside «Más»", async () => {
    calls.readDebtModel
      .mockResolvedValueOnce("informal")
      .mockResolvedValueOnce("informal");
    const html = await renderedHtml();

    expect(bar(html)).not.toMatch(/data-ficha-action="saldo-pendiente"/);
    expect(bar(html)).toContain("data-ficha-more");
    expect(panel(await renderedHtml(PUBLIC_ID, { accion: "saldo-pendiente" }))).toContain(
      "Saldo pendiente (EUR)",
    );
  });

  test("a re-baseline alone (no plan row) also retires the door, and recalibrar leads", async () => {
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

    expect(bar(html)).not.toContain("saldo-pendiente");
    expect(bar(html)).toMatch(/class="btn"[^>]*data-ficha-action="recalibrar"/);
    expect(html).not.toContain("180.000");
    expect(header(html)).toContain("Cuota vigente");
  });
});
