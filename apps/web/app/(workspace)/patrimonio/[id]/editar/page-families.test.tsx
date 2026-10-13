import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ficha picks ONE surface family and loads only that family's rows (#1607).
 *
 * The mortgage case lives in `page.test.tsx`; this file pins the other two the
 * acceptance criteria name — an investment and a stored holding — along the axis
 * the refactor is about: what renders, and what is NOT read to render it. Every
 * store method is a spy, so "cada familia carga solo lo que pinta" is an
 * assertion here rather than a claim in a comment.
 *
 * The investment family is also the first on the tabbed ficha (#1826): its block
 * pins what that skeleton promises — the state header and its bar, the tabs, one
 * action at a time — and that the links that already exist land where they did.
 */

const ASSET_ID = "asset_fondo";
const PUBLIC_ID = "wl_hld_fondo";

const FUND = {
  currency: "EUR",
  currentValue: { amountMinor: 12_000_00, currency: "EUR" },
  id: ASSET_ID,
  instrument: "fund",
  isPrimaryResidence: false,
  liquidityTier: "invested",
  name: "Fondo Azul",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  providerSymbol: "IE00B4L5Y983",
  type: "investment",
};

const FLAT = {
  currency: "EUR",
  currentValue: { amountMinor: 240_000_00, currency: "EUR" },
  id: ASSET_ID,
  instrument: "property",
  isPrimaryResidence: false,
  liquidityTier: "housing",
  name: "Piso de Chamberí",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "property",
};

const COINS = {
  currency: "EUR",
  currentValue: { amountMinor: 4_100_00, currency: "EUR" },
  id: ASSET_ID,
  instrument: "coin_collection",
  isPrimaryResidence: false,
  liquidityTier: "invested",
  name: "Colección de plata",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "investment",
};

const CRYPTO = {
  // The asset's OWN back-link (#248): a source materializes one asset per rung, so
  // this is the routing fact — not the `asset_id` the source row names.
  connectedSourceId: "source_binance",
  currency: "EUR",
  currentValue: { amountMinor: 2_800_00, currency: "EUR" },
  id: ASSET_ID,
  instrument: "crypto",
  isPrimaryResidence: false,
  liquidityTier: "invested",
  name: "Binance · mercado",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "investment",
};

const CASH = {
  currency: "EUR",
  currentValue: { amountMinor: 3_500_00, currency: "EUR" },
  id: ASSET_ID,
  instrument: "current_account",
  isPrimaryResidence: false,
  liquidityTier: "cash",
  name: "Cuenta nómina",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "cash",
};

/** A term deposit: stored like the account, but locked until a date (ADR 0013). */
const DEPOSIT = {
  ...CASH,
  currentValue: { amountMinor: 20_000_00, currency: "EUR" },
  instrument: "term_deposit",
  liquidityTier: "term-locked",
  name: "Depósito 12 meses",
  type: "manual",
};

/** The investment row behind the fund: what «Lo básico» edits and the price surfaces need. */
const INVESTMENT = {
  assetId: ASSET_ID,
  benchmarkDistributing: false,
  id: ASSET_ID,
  isin: "IE00B4L5Y983",
  name: "Fondo Azul",
  priceProvider: "yahoo",
  providerSymbol: "IWDA.AS",
};

const OPERATION = {
  assetId: ASSET_ID,
  currency: "EUR",
  executedAt: "2026-03-02",
  feesMinor: 0,
  id: "op_1",
  kind: "buy",
  pricePerUnit: "100.00",
  units: "100",
};

/** A fresh Yahoo quote: 100 participaciones at 120 € are worth 12.000 €. */
const PRICE = {
  assetId: ASSET_ID,
  currency: "EUR",
  fetchedAt: "2026-08-28T08:00:00.000Z",
  freshnessState: "fresh",
  price: "120.00",
  source: "yahoo",
};

const POSITION = {
  assetId: ASSET_ID,
  averageUnitCost: "100.00",
  costBasis: { amountMinor: 10_000_00, currency: "EUR" },
  currency: "EUR",
  currentPricePerUnit: "120.00",
  currentUnits: "100",
  marketValue: { amountMinor: 12_000_00, currency: "EUR" },
  name: "Fondo Azul",
  realizedPnl: { amountMinor: 0, currency: "EUR" },
  unrealizedPnl: { amountMinor: 2_000_00, currency: "EUR" },
  warnings: [],
};

/** The URL the island reads through `useSearchParams` — set per render. */
const url = vi.hoisted(() => ({ search: new URLSearchParams() }));

const calls = vi.hoisted(() => ({
  // Asset-side reads
  readAcquisitionCostMinor: vi.fn(async (): Promise<number | null> => null),
  readAnnualAppreciationRate: vi.fn(async (): Promise<string | null> => null),
  readAssets: vi.fn(async (): Promise<unknown[]> => []),
  readAvailableFrom: vi.fn(async (): Promise<string | null> => null),
  readContributionLots: vi.fn(async (): Promise<unknown[]> => []),
  readInvestmentAssetById: vi.fn(async (): Promise<unknown> => null),
  readValuationAnchors: vi.fn(async (): Promise<unknown[]> => []),
  readValuationCadence: vi.fn(async (): Promise<string | null> => null),
  // Ledger-side reads
  readOperations: vi.fn(async (): Promise<unknown[]> => []),
  readPriceCache: vi.fn(async (): Promise<unknown> => null),
  readTransferCounterparts: vi.fn(async () => new Map<string, unknown>()),
  readPositions: vi.fn(async (): Promise<unknown[]> => []),
  readSnapshotHoldings: vi.fn(async (): Promise<unknown[]> => []),
  // Connected sources
  listSources: vi.fn(async (): Promise<unknown[]> => []),
  readSourceIdForAsset: vi.fn(async (): Promise<string | null> => null),
  readSourcePositions: vi.fn(async (): Promise<unknown[]> => []),
  // Liability-side reads — never touched by an asset ficha
  readAmortizationPlan: vi.fn(async (): Promise<unknown> => null),
  readBalanceAnchors: vi.fn(async (): Promise<unknown[]> => []),
  readBalanceRebaselines: vi.fn(async (): Promise<unknown[]> => []),
  readDebtModel: vi.fn(async (): Promise<string | null> => null),
  readDebtValuationCadence: vi.fn(async (): Promise<string | null> => null),
  readEarlyRepayments: vi.fn(async (): Promise<unknown[]> => []),
  readInterestRateRevisions: vi.fn(async (): Promise<unknown[]> => []),
  readLiabilities: vi.fn(async (): Promise<unknown[]> => []),
  // A hand-set value's freshness: the audit history and the creation day (#1846)
  readAssetCreatedAtById: vi.fn(async () => new Map<string, string>()),
  readManualValueHistory: vi.fn(async () => new Map<string, unknown[]>()),
  // Shared chrome
  readCashContainerName: vi.fn(async (): Promise<string | null> => null),
  readFireConfig: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  readPayoutSchedulesForHolding: vi.fn(async (): Promise<unknown[]> => []),
  readPayoutsForHolding: vi.fn(async (): Promise<unknown[]> => []),
  readPublicIds: vi.fn(async () => [
    { entityId: ASSET_ID, entityType: "holding" as const, publicId: PUBLIC_ID },
  ]),
  readWarningOverrides: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@web/page-shell", () => ({
  resolvePageShell: async () => {
    const scopes = [{ id: "household", label: "Hogar", type: "household" }];
    return {
      persistence: { checkedAt: "2026-08-29T00:00:00.000Z", status: "ok" },
      privacyMode: false,
      requestedScopeId: undefined,
      scopes,
      selectedScope: scopes[0],
      store: {
        agentView: {
          readAssetCreatedAtById: calls.readAssetCreatedAtById,
          readManualValueHistory: calls.readManualValueHistory,
          readPublicIds: calls.readPublicIds,
        },
        assets: {
          readAcquisitionCostMinor: calls.readAcquisitionCostMinor,
          readAnnualAppreciationRate: calls.readAnnualAppreciationRate,
          readAssets: calls.readAssets,
          readAvailableFrom: calls.readAvailableFrom,
          readContributionLots: calls.readContributionLots,
          readInvestmentAssetById: calls.readInvestmentAssetById,
          readValuationAnchors: calls.readValuationAnchors,
          readValuationCadence: calls.readValuationCadence,
        },
        connectedSources: {
          listSources: calls.listSources,
          readPositions: calls.readSourcePositions,
          readSourceIdForAsset: calls.readSourceIdForAsset,
        },
        liabilities: {
          readAmortizationPlan: calls.readAmortizationPlan,
          readBalanceAnchors: calls.readBalanceAnchors,
          readBalanceRebaselines: calls.readBalanceRebaselines,
          readDebtModel: calls.readDebtModel,
          readEarlyRepayments: calls.readEarlyRepayments,
          readInterestRateRevisions: calls.readInterestRateRevisions,
          readLiabilities: calls.readLiabilities,
          readValuationCadence: calls.readDebtValuationCadence,
        },
        managedPortfolios: { readCashContainerName: calls.readCashContainerName },
        operations: {
          readOperations: calls.readOperations,
          readPriceCache: calls.readPriceCache,
          readTransferCounterparts: calls.readTransferCounterparts,
        },
        payouts: {
          readPayoutSchedulesForHolding: calls.readPayoutSchedulesForHolding,
          readPayoutsForHolding: calls.readPayoutsForHolding,
        },
        readFireConfig: calls.readFireConfig,
        readWarningOverrides: calls.readWarningOverrides,
        snapshots: {
          readPositions: calls.readPositions,
          readSnapshotHoldings: calls.readSnapshotHoldings,
        },
      },
      target: { kind: "local" },
      workspace: {
        baseCurrency: "EUR",
        groups: [],
        members: [{ id: "member_jose", name: "Jose" }],
        mode: "individual",
      },
    };
  },
}));

vi.mock("@web/demo/write-guard", () => ({ isDemoMode: async () => false }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
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
// The exposure catalog is a control-plane read, not a store one: stub it so the
// benchmark card's absence is a decision of the data, not of the network.
vi.mock("@web/read-exposure-catalog", () => ({
  readExposureProfilesFromCatalog: async () => [],
}));

import EditarPage from "./page";

async function renderedHtml(searchParams: Record<string, string> = {}): Promise<string> {
  url.search = new URLSearchParams(searchParams);
  const element = (await EditarPage({
    params: Promise.resolve({ id: PUBLIC_ID }),
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

beforeEach(() => {
  vi.clearAllMocks();
  calls.readPublicIds.mockResolvedValue([
    { entityId: ASSET_ID, entityType: "holding" as const, publicId: PUBLIC_ID },
  ]);
});

describe("EditarPage — the investment family (#1607)", () => {
  beforeEach(() => {
    calls.readAssets.mockResolvedValue([FUND]);
    calls.readInvestmentAssetById.mockResolvedValue(INVESTMENT);
    calls.readOperations.mockResolvedValue([OPERATION]);
    calls.readPositions.mockResolvedValue([POSITION]);
    calls.readPriceCache.mockResolvedValue(PRICE);
  });

  test("it reads no other family's rows", async () => {
    await renderedHtml();

    // Housing, debt and connected-source rows are not read for a fund. Before
    // #1607 the page issued the housing and debt reads' guards inline and the
    // Numista source listing for every asset.
    expect(calls.readValuationAnchors).not.toHaveBeenCalled();
    expect(calls.readAcquisitionCostMinor).not.toHaveBeenCalled();
    expect(calls.readDebtModel).not.toHaveBeenCalled();
    expect(calls.listSources).not.toHaveBeenCalled();
    // A fund is not crypto, so the Binance back-link is never asked for either.
    expect(calls.readSourceIdForAsset).not.toHaveBeenCalled();
    // …and an investment holding cannot be a portfolio's cash casilla (ADR 0085).
    expect(calls.readCashContainerName).not.toHaveBeenCalled();
  });
});

describe("EditarPage — the investment ficha is a state header with tabs (#1826)", () => {
  beforeEach(() => {
    calls.readAssets.mockResolvedValue([FUND]);
    calls.readInvestmentAssetById.mockResolvedValue(INVESTMENT);
    calls.readOperations.mockResolvedValue([OPERATION]);
    calls.readPositions.mockResolvedValue([POSITION]);
    calls.readPriceCache.mockResolvedValue(PRICE);
  });

  test("it opens on its state and its bar, and there is no «Configuración avanzada»", async () => {
    const html = await renderedHtml();

    expect(html).not.toContain("Configuración avanzada");
    expect(html).toContain('aria-label="Estado del activo"');
    expect(html).toContain("<h2>Fondo Azul</h2>");
    expect(html).toContain("← Patrimonio");
    expect(html).toContain(`href="/patrimonio#${PUBLIC_ID}"`);
    // The value, then units at the price that valued them.
    expect(html).toMatch(/class="fichaValue">12\.?000\s€/);
    // «220 a 118,75 €», as the spec words it (#1731).
    expect(html).toContain("100 a 120 €");
    expect(html).toContain("Actualizar precio");
    // The board row's figure (#551): 12.000 € against a 10.000 € cost.
    expect(html).toContain("Ganancia total");
    expect(html).toMatch(/2\.?000\s€ · \+20,0 %/);
    expect(html).toContain("Rentabilidad anual");
    expect(html).toContain(">TIR</abbr>");
  });

  test("the bar puts the habitual action first, two at hand and the rest in «Más»", async () => {
    const html = await renderedHtml();
    const bar = html.slice(
      html.indexOf('aria-label="Acciones del activo"'),
      html.indexOf('class="fichaFigures"'),
    );

    // The only ink-filled button is the habitual one (#1732).
    expect(bar).toContain('class="btn" data-ficha-action="operacion"');
    expect(bar).toContain('class="btn btnSecondary" data-ficha-action="traspaso"');
    expect(bar).toContain("Más");
    // The rarer ones are behind «Más», not in the bar.
    expect(bar).not.toContain('data-ficha-action="extracto"');
    expect(bar).not.toContain('data-ficha-action="correccion"');
  });

  test("«Añadir cobro» is at hand once the holding has paid something, and in «Más» before (#1829)", async () => {
    const barOf = (html: string) =>
      html.slice(
        html.indexOf('aria-label="Acciones del activo"'),
        html.indexOf('class="fichaFigures"'),
      );

    // A fund that never paid anything does not need the button in view.
    expect(barOf(await renderedHtml())).not.toContain('data-ficha-action="cobro"');

    calls.readPayoutsForHolding.mockResolvedValueOnce([
      { amountMinor: 12_50, dateISO: "2026-06-01", holdingId: ASSET_ID, id: "pay_1" },
    ]);
    expect(barOf(await renderedHtml())).toContain(
      'class="btn btnSecondary" data-ficha-action="cobro"',
    );
  });

  test("the cobro panel asks first which kind, and opens on the one-off (#1829)", async () => {
    const cobro = panel(await renderedHtml({ accion: "cobro" }));

    expect(cobro).toContain("Un cobro suelto");
    expect(cobro).toContain("Uno que se repite");
    // The one-off is the habitual cobro of a fund (a dividend), so it starts chosen.
    expect(cobro).toMatch(/checked=""[^>]*value="suelto"|value="suelto"[^>]*checked=""/);
    // Each form in its own pane, the one shown being the chosen one.
    const oneOff = cobro.indexOf('data-seed-choice="suelto"');
    const recurring = cobro.indexOf('data-seed-choice="recurrente"');
    expect(oneOff).toBeGreaterThan(-1);
    expect(recurring).toBeGreaterThan(oneOff);
    expect(cobro.slice(oneOff, recurring)).toContain("Registrar un cobro puntual");
    expect(cobro.slice(recurring)).toContain("Declarar un cobro recurrente");
  });

  test("a success is said beside the tabs, once (#1829)", async () => {
    const html = await renderedHtml({ ok: "saved" });

    // Between the state header and the tabs, where the landed row is — the band
    // that offers «Añadir otra» once the panel's submit is the one that landed.
    const notice = html.indexOf('role="status">Guardado.</p>');
    expect(notice).toBeGreaterThan(html.indexOf('aria-label="Estado del activo"'));
    expect(notice).toBeLessThan(html.indexOf('aria-label="Secciones de la ficha"'));
    expect(html.split("Guardado.")).toHaveLength(2);
  });

  test("four tabs with their counts, and the ledger on show by default", async () => {
    const html = await renderedHtml();
    const tabs = html.slice(html.indexOf('aria-label="Secciones de la ficha"'));

    expect(tabs).toMatch(/Operaciones<span class="fichaTabCount">1</);
    expect(tabs).toContain("Rentabilidad");
    expect(tabs).toMatch(/Cobros<span class="fichaTabCount">0</);
    expect(tabs).toContain('<span class="fichaTabWide">Datos del activo</span>');
    expect(tabs).toContain('<span class="fichaTabNarrow">Datos</span>');
    expect(html).toContain('aria-current="true" class="navTab active"');

    const body = tabBody(html);
    expect(body).toContain('id="operaciones"');
    // The delete posts the operation and returns to this tab, by the PUBLIC id.
    expect(body).toContain('value="op_1"');
    expect(body).toContain(`value="/patrimonio/${PUBLIC_ID}/editar"`);
    // No panel is open, and no form is rendered twice to be hidden by CSS.
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-label="Registrar operación"');
  });

  test("«Datos del activo» holds «Lo básico», the availability and the Zona de peligro last", async () => {
    const html = await renderedHtml({ pestaña: "datos" });
    const body = tabBody(html);

    expect(body).toContain("Lo básico");
    expect(body.indexOf("Zona de peligro")).toBeGreaterThan(body.indexOf("Lo básico"));
    // Its forms return to this tab, not to the ledger.
    expect(body).toContain(`value="/patrimonio/${PUBLIC_ID}/editar?pesta%C3%B1a=datos"`);
    expect(body).not.toContain('id="operaciones"');
  });

  test("each action opens alone in the side panel, returning to the tab its result shows on", async () => {
    const record = panel(await renderedHtml({ accion: "operacion" }));
    expect(record).toContain('role="dialog"');
    expect(record).toContain('<h3 id="ficha-panel-title">Registrar operación</h3>');
    expect(record).toContain('aria-label="Registrar operación"');
    expect(record).toContain(`value="/patrimonio/${PUBLIC_ID}/editar"`);

    const cobro = panel(await renderedHtml({ accion: "cobro" }));
    expect(cobro).toContain("Registrar un cobro puntual");
    expect(cobro).toContain(
      `value="/patrimonio/${PUBLIC_ID}/editar?pesta%C3%B1a=cobros"`,
    );

    const correction = panel(await renderedHtml({ accion: "correccion" }));
    expect(correction).toContain("<h3>Corregir precio de un día</h3>");
    expect(correction).toContain(
      `value="/patrimonio/${PUBLIC_ID}/editar?pesta%C3%B1a=rentabilidad"`,
    );
  });

  test("the three ?abrir= links land where they promised", async () => {
    // `holdingOperationsHref`: the ledger.
    expect(tabBody(await renderedHtml({ abrir: "operaciones" }))).toContain(
      'id="operaciones"',
    );
    // `holdingCobrosHref`: the Cobros tab, its `#cobros` fragment on screen.
    const cobros = tabBody(await renderedHtml({ abrir: "cobros" }));
    expect(cobros).toContain('id="cobros"');
    // A fund that never paid anything: the record says so (#1830).
    expect(cobros).toContain("Este activo no ha pagado nada todavía.");
    // The Papelera's «Lo traspasé a…» exit (#1549): the traspaso, with its intent.
    const traspaso = panel(await renderedHtml({ abrir: "traspaso", archivar: "1" }));
    expect(traspaso).toContain("<h3>Traspasar</h3>");
  });

  test("a refusal reopens its form, and «Traer de otra entidad» prints it once", async () => {
    const message = "La fecha no puede ser futura.";
    const html = await renderedHtml({ error: message, form: "externalEntry" });

    expect(panel(html)).toContain("<h3>Traer de otra entidad</h3>");
    // Its own band only: the page band used to print it a second time.
    expect(html.split(message)).toHaveLength(2);
  });

  test("a refused cobro reopens «Añadir cobro» over its tab, with what was typed (#1731 review)", async () => {
    const message = "Introduce un importe mayor que cero.";
    const html = await renderedHtml({
      error: message,
      form: "payoutOneOff",
      v_amount: "0",
      v_note: "Dividendo",
    });

    expect(panel(html)).toContain('<h3 id="ficha-panel-title">Añadir cobro</h3>');
    expect(panel(html)).toContain('value="Dividendo"');
    expect(tabBody(html)).toContain('id="cobros"');
    // Once, in the form that produced it: not on the tab, not on the page band.
    expect(html.split(message)).toHaveLength(2);
  });

  test("the header's gain folds the cobros the board's row folds (#657)", async () => {
    // A 500 € dividend: the board's row counts it as realized gain, so the ficha has
    // to as well — 2.000 € of price plus 500 € paid, against 10.000 € invested.
    calls.readPayoutsForHolding.mockResolvedValueOnce([
      { amountMinor: 500_00, dateISO: "2026-06-01", holdingId: ASSET_ID, id: "pay_1" },
    ]);

    const html = await renderedHtml();

    expect(html).toMatch(/2\.?500\s€ · \+25,0 %/);
    expect(html).toMatch(/Cobros<span class="fichaTabCount">1</);
  });

  test("a fund with no cobros says it in one line, with the door to «Añadir cobro» (#1830)", async () => {
    const body = tabBody(await renderedHtml({ pestaña: "cobros" }));

    expect(body).toContain("Este activo no ha pagado nada todavía.");
    // No block of zeros: no renta-pasiva strip, no month grid.
    expect(body).not.toContain("Renta pasiva");
    expect(body).not.toContain("cobrosPasiva");
    // The link opens the «Añadir cobro» panel over this tab — a real href, so it
    // lands with JS off too.
    expect(body).toContain(
      `href="/patrimonio/${PUBLIC_ID}/editar?pesta%C3%B1a=cobros&amp;accion=cobro"`,
    );
  });

  test("the Rentabilidad tab measures what the header measures", async () => {
    const html = await renderedHtml({ pestaña: "rentabilidad" });

    // The same fold, the same 2.000 €: the panel and the header cannot disagree.
    expect(tabBody(html)).toMatch(/2\.?000\s€/);
    // Two questions faced, the owner's money first (#1830).
    const body = tabBody(html);
    expect(body.indexOf("Tu dinero")).toBeGreaterThan(-1);
    expect(body.indexOf("El fondo")).toBeGreaterThan(body.indexOf("Tu dinero"));
  });
});

/**
 * The header is honest about its price (#1828): it says where the price comes from
 * and of when, as the valuation that picked it says — never by comparing figures
 * afterwards — and the one warning about that price sits beside it.
 */
describe("EditarPage — the investment header says where its price comes from (#1828)", () => {
  /** The figures row: from the units to the end of the state header. */
  const figures = (html: string) =>
    html.slice(html.indexOf('class="fichaFigures"'), html.indexOf('class="fichaTabs"'));
  /** The warnings band above the header, when there is one. */
  const band = (html: string) => {
    const at = html.indexOf('aria-label="Avisos"');
    return at === -1
      ? ""
      : html.slice(at, html.indexOf('aria-label="Estado del activo"'));
  };
  /** The opening tag of the link that reads `text`, or "" when there is none. */
  const linkTo = (html: string, text: string) =>
    [...html.matchAll(/<a [^>]*>([^<]*)</g)].find((match) => match[1] === text)?.[0] ??
    "";

  beforeEach(() => {
    calls.readAssets.mockResolvedValue([FUND]);
    calls.readInvestmentAssetById.mockResolvedValue(INVESTMENT);
    calls.readOperations.mockResolvedValue([OPERATION]);
    calls.readPositions.mockResolvedValue([POSITION]);
    calls.readPriceCache.mockResolvedValue(PRICE);
  });

  test("a provider's quote: units at that price, the provider and the day", async () => {
    const html = figures(await renderedHtml());

    expect(html).toContain("100 a 120 €");
    // A fresh fetch with no market day of its own is dated by the fetch.
    expect(html).toContain("cotización Yahoo · 28/08/2026");
  });

  test("the quote's market day wins over the day it was fetched", async () => {
    calls.readPriceCache.mockResolvedValue({ ...PRICE, priceDate: "2026-08-27" });

    expect(figures(await renderedHtml())).toContain("cotización Yahoo · 27/08/2026");
  });

  test("a hand-set price says so, dated by when it was set", async () => {
    calls.readPriceCache.mockResolvedValue(null);
    calls.readInvestmentAssetById.mockResolvedValue({
      ...INVESTMENT,
      manualPricePerUnit: "110",
      manualPricedAt: "2026-08-20T09:00:00.000Z",
    });

    const html = figures(await renderedHtml());
    expect(html).toContain("100 a 110 €");
    expect(html).toContain("precio a mano · 20/08/2026");
  });

  test("a hand-set price equal to the last purchase is not passed off as that purchase", async () => {
    // The prototype's trap (#1731): the buy was at 100 and so is the hand-set price.
    calls.readPriceCache.mockResolvedValue(null);
    calls.readInvestmentAssetById.mockResolvedValue({
      ...INVESTMENT,
      manualPricePerUnit: "100.00",
    });

    const html = figures(await renderedHtml());
    expect(html).toContain("precio a mano");
    expect(html).not.toContain("última operación");
  });

  test("with no price it is valued at what it cost, and says so", async () => {
    calls.readPriceCache.mockResolvedValue(null);

    const html = await renderedHtml();
    expect(html).toMatch(/class="fichaValue">10\.?000\s€/);
    expect(figures(html)).toContain("sin precio: se valora a lo que costó");
    // The units alone: there is no price to print them at.
    expect(figures(html)).toContain('<span class="fichaFigure ">100</span>');
  });

  test("no symbol: the warning sits beside the price, not in the band", async () => {
    const { providerSymbol: _, ...noSymbol } = FUND;
    calls.readAssets.mockResolvedValue([noSymbol]);

    const html = await renderedHtml();
    const row = figures(html);

    expect(row).toContain("Sin cotización automática.");
    // «Indicar símbolo» opens «Datos del activo» on the symbol field — a real href
    // for no-JS, and what the island needs to focus the field.
    const fix = linkTo(row, "Indicar símbolo");
    expect(fix).toContain('href="/patrimonio/wl_hld_fondo/editar?pesta%C3%B1a=datos"');
    expect(fix).toContain('data-ficha-tab="datos"');
    expect(fix).toContain('data-ficha-field="providerSymbol"');
    // «Cotiza a mano» is today's «Es intencional»: the same override, same code.
    expect(row).toContain('type="hidden" name="code" value="MISSING_PROVIDER_SYMBOL"');
    expect(row).toContain(`type="hidden" name="entityId" value="${ASSET_ID}"`);
    expect(row).toContain(">Cotiza a mano</button>");
    // …and the band no longer carries it.
    expect(band(html)).not.toContain("símbolo de proveedor");
  });

  test("a symbol marked intentional is silent beside the price too", async () => {
    const { providerSymbol: _, ...noSymbol } = FUND;
    calls.readAssets.mockResolvedValue([noSymbol]);
    calls.readWarningOverrides.mockResolvedValue([
      { code: "MISSING_PROVIDER_SYMBOL", entityId: ASSET_ID },
    ]);

    expect(figures(await renderedHtml())).not.toContain("Sin cotización automática");
  });

  test("the other warnings stay in the band, each linking to where it is fixed", async () => {
    // Sold more than was bought: the ledger is where that gets fixed.
    calls.readOperations.mockResolvedValue([
      OPERATION,
      { ...OPERATION, executedAt: "2026-04-02", id: "op_2", kind: "sell", units: "150" },
    ]);

    const html = await renderedHtml({ pestaña: "datos" });

    expect(band(html)).toContain("ventas/traspasos por encima");
    const fix = linkTo(band(html), "Ver operaciones");
    expect(fix).toContain('href="/patrimonio/wl_hld_fondo/editar"');
    expect(fix).toContain('data-ficha-tab="operaciones"');
    expect(band(html)).toContain("Es intencional");
  });
});

describe("EditarPage — the stored ficha is a state header with tabs (#1846)", () => {
  const FICHA = `/patrimonio/${PUBLIC_ID}/editar`;
  const bar = (html: string) =>
    html.slice(
      html.indexOf('aria-label="Acciones del activo"'),
      html.indexOf('class="fichaFigures"'),
    );
  const figures = (html: string) =>
    html.slice(html.indexOf('class="fichaFigures"'), html.indexOf('class="fichaTabs"'));
  /** The figure whose label is `label`, up to the next one. */
  const figure = (html: string, label: string) => {
    const row = figures(html);
    const at = row.indexOf(`<dt>${label}</dt>`);
    if (at === -1) return "";
    const next = row.indexOf("<dt>", at + 1);
    return row.slice(at, next === -1 ? undefined : next);
  };
  const ago = (days: number) =>
    new Date(Date.UTC(2026, 9, 13) - days * 86_400_000).toISOString().slice(0, 10);

  beforeEach(() => {
    // One clock for the page's «today»: only `Date`, so promises still settle.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T10:00:00.000Z"));
    calls.readAssets.mockResolvedValue([CASH]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a current account opens on its value, its freshness, its availability and its bar", async () => {
    calls.readManualValueHistory.mockResolvedValueOnce(
      new Map([[ASSET_ID, [{ dateKey: ago(12), valueMinor: 3_500_00 }]]]),
    );
    const html = await renderedHtml();

    expect(html).not.toContain("Configuración avanzada");
    expect(html).toContain("<h2>Cuenta nómina</h2>");
    expect(html).toContain('<span class="fichaInstrument">Cuenta corriente</span>');
    // The board row's figure: the stored value, untransformed.
    expect(html).toMatch(/class="fichaValue">3\.?500\s€/);
    expect(figure(html, "Puesto al día")).toContain("01/10/2026");
    expect(figure(html, "Puesto al día")).toContain("hace 12 días");
    expect(figure(html, "Disponibilidad")).toContain("Caja");
    // A rung is a word, not a figure: it is set in the body face (canon §3).
    expect(figure(html, "Disponibilidad")).toMatch(
      /class="fichaFigure fichaFigureText[^"]*">Caja</,
    );
    expect(figure(html, "Puesto al día")).not.toContain("fichaFigureText");
    // A total, never a movement: no sign colour on any of them (canon §6).
    expect(figures(html)).not.toMatch(/fichaFigure (pos|neg)/);
    expect(bar(html)).toContain('class="btn" data-ficha-action="valor"');
    expect(bar(html)).toContain(">Actualizar valor</button>");
  });

  test("past the aviso's threshold it says so, in the aviso's words", async () => {
    calls.readManualValueHistory.mockResolvedValueOnce(
      new Map([[ASSET_ID, [{ dateKey: ago(90), valueMinor: 3_500_00 }]]]),
    );
    const stale = figure(await renderedHtml(), "Puesto al día");

    expect(stale).toContain("15/07/2026");
    expect(stale).toContain("lleva más de 90 días sin actualizarse");
    expect(stale).not.toContain("hace 90 días");
  });

  test("with no value ever set by hand, it is dated by the day the holding was created", async () => {
    calls.readAssetCreatedAtById.mockResolvedValueOnce(
      new Map([[ASSET_ID, `${ago(3)}T09:00:00.000Z`]]),
    );

    expect(figure(await renderedHtml(), "Puesto al día")).toContain("hace 3 días");
  });

  test("a term deposit says since when it can be touched", async () => {
    calls.readAssets.mockResolvedValue([{ ...DEPOSIT, availableFrom: "2027-03-01" }]);

    const availability = figure(await renderedHtml(), "Disponibilidad");
    expect(availability).toContain("A plazo");
    expect(availability).toContain("desde 01/03/2027");
  });

  test("a term deposit with no date says it, and links to where it is declared", async () => {
    calls.readAssets.mockResolvedValue([DEPOSIT]);

    const availability = figure(await renderedHtml(), "Disponibilidad");
    expect(availability).toContain("Sin fecha declarada");
    const link = availability.match(/<a [^>]*>Declarar fecha<\/a>/)?.[0] ?? "";
    expect(link).toContain(`href="${FICHA}?pesta%C3%B1a=datos"`);
    expect(link).toContain('data-ficha-tab="datos"');
    expect(link).toContain('data-ficha-field="availableFrom"');
    // …and the field it focuses is on that tab.
    expect(tabBody(await renderedHtml({ pestaña: "datos" }))).toContain(
      'name="availableFrom"',
    );
  });

  test("«Añadir cobro» is at hand once it has paid something, and in «Más» before", async () => {
    expect(bar(await renderedHtml())).not.toContain('data-ficha-action="cobro"');

    calls.readPayoutsForHolding.mockResolvedValueOnce([
      { amountMinor: 12_50, dateISO: "2026-06-01", holdingId: ASSET_ID, id: "pay_1" },
    ]);
    expect(bar(await renderedHtml())).toContain(
      'class="btn btnSecondary" data-ficha-action="cobro"',
    );
  });

  test("Cobros opens by default with its count, then «Datos del activo»", async () => {
    const html = await renderedHtml();
    const tabs = html.slice(html.indexOf('aria-label="Secciones de la ficha"'));

    expect(tabs).toMatch(/Cobros<span class="fichaTabCount">0</);
    expect(tabs.indexOf("Datos del activo")).toBeGreaterThan(tabs.indexOf("Cobros"));
    expect(tabBody(html)).toContain('id="cobros"');
    expect(tabBody(html)).toContain("Este activo no ha pagado nada todavía.");
    // `holdingCobrosHref` lands there too — the contract rentas, FIRE and salud use.
    expect(tabBody(await renderedHtml({ abrir: "cobros" }))).toContain('id="cobros"');
  });

  test("«Actualizar valor» opens in the panel and comes back to the ficha", async () => {
    const valor = panel(await renderedHtml({ accion: "valor" }));

    expect(valor).toContain('<h3 id="ficha-panel-title">Actualizar valor</h3>');
    expect(valor).toContain('aria-label="Valor actual en EUR"');
    expect(valor).toMatch(
      /name="currentValue"[^>]*value="3\.?500,00"|value="3\.?500,00"[^>]*name="currentValue"/,
    );
    // A refusal returns to the ficha; so does the success (`returnTo`).
    expect(valor).toContain(`name="currentUrl" value="${FICHA}"`);
    expect(valor).toContain(`name="returnTo" value="${FICHA}"`);
    // Alone in the panel there is no identity form above it to be ruled off from.
    expect(valor).not.toContain("updateValueForm");
  });

  test("the value form left «Lo básico»: the panel is its one place", async () => {
    const datos = tabBody(await renderedHtml({ pestaña: "datos" }));

    expect(datos).toContain("Lo básico");
    expect(datos).not.toContain('name="currentValue"');
    expect(datos.indexOf("Zona de peligro")).toBeGreaterThan(datos.indexOf("Lo básico"));
  });

  test("the cobro panel returns to Cobros, the default tab", async () => {
    expect(panel(await renderedHtml({ accion: "cobro" }))).toContain(
      `name="currentUrl" value="${FICHA}"`,
    );
  });

  test("a refused value reopens the panel with what was typed, and says why once", async () => {
    const message = "El valor del activo no es válido.";
    const html = await renderedHtml({
      error: message,
      form: "value",
      v_currentValue: "tres mil",
    });

    expect(panel(html)).toContain('<h3 id="ficha-panel-title">Actualizar valor</h3>');
    expect(panel(html)).toContain('value="tres mil"');
    expect(panel(html)).toContain(message);
    expect(html.split(message)).toHaveLength(2);
  });

  test("it loads only what it paints", async () => {
    await renderedHtml();

    // Its cobros, its cash-container gate (ADR 0085), and the freshness the aviso
    // reads — for THIS holding — and not one row of a ledger, a curve or a debt.
    expect(calls.readPayoutsForHolding).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.readCashContainerName).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.readManualValueHistory).toHaveBeenCalledWith([ASSET_ID]);
    expect(calls.readAssetCreatedAtById).toHaveBeenCalledTimes(1);
    expect(calls.readOperations).not.toHaveBeenCalled();
    expect(calls.readPositions).not.toHaveBeenCalled();
    expect(calls.readSnapshotHoldings).not.toHaveBeenCalled();
    expect(calls.readInvestmentAssetById).not.toHaveBeenCalled();
    expect(calls.readValuationAnchors).not.toHaveBeenCalled();
    expect(calls.readDebtModel).not.toHaveBeenCalled();
    // The date lives on the row it already has: no extra read for the header.
    expect(calls.readAvailableFrom).not.toHaveBeenCalled();
  });
});

describe("EditarPage — the housing family (#1607)", () => {
  beforeEach(() => {
    calls.readAssets.mockResolvedValue([FLAT]);
  });

  test("the valuation curve and the acquisition cost sit BELOW cobros", async () => {
    const html = await renderedHtml();

    // The order the ficha has always had: what the flat PAYS comes before the
    // slower conversation about what it is worth. The family owns that order now,
    // so it is the thing a re-split could silently invert.
    const cobros = html.indexOf("<h3>Cobros</h3>");
    expect(cobros).toBeGreaterThan(-1);
    expect(html.indexOf("<h3>Valoración del inmueble</h3>")).toBeGreaterThan(cobros);
    expect(html.indexOf("<h3>Coste de adquisición</h3>")).toBeGreaterThan(
      html.indexOf("<h3>Valoración del inmueble</h3>"),
    );
    expect(html).not.toContain('id="operaciones"');
  });

  test("Cobros is still where the assistant sends a rent's expenses (#1524)", async () => {
    const html = await renderedHtml();

    // «la ficha del inmueble, desplegando «Configuración avanzada» → «Cobros»»: the
    // property keeps the accordion until #1824 moves it to tabs, as the investment
    // ficha moved in #1826. When it does, this and the destination change together.
    const body = html.indexOf('<div class="editAdvancedBody">');
    expect(body).toBeGreaterThan(-1);
    expect(html.indexOf("<h3>Cobros</h3>")).toBeGreaterThan(body);
    expect(html.indexOf("<h3>Cobros</h3>")).toBeLessThan(html.indexOf("</details>"));
    expect(html).toContain("Gastos");
  });

  test("it reads the four housing rows and no ledger", async () => {
    await renderedHtml();

    expect(calls.readValuationAnchors).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.readAnnualAppreciationRate).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.readAcquisitionCostMinor).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.readOperations).not.toHaveBeenCalled();
    expect(calls.readDebtModel).not.toHaveBeenCalled();
  });
});

describe("EditarPage — the coin-collection family (#1607)", () => {
  beforeEach(() => {
    calls.readAssets.mockResolvedValue([COINS]);
    calls.listSources.mockResolvedValue([
      {
        adapter: "numista",
        assetId: ASSET_ID,
        id: "source_numista",
        lastSyncAt: "2026-08-20T10:00:00.000Z",
      },
    ]);
  });

  test("it mirrors its source and places cobros after it", async () => {
    const html = await renderedHtml();

    const coins = html.indexOf("Sincronizar Numista");
    expect(coins).toBeGreaterThan(-1);
    expect(html.indexOf("<h3>Cobros</h3>")).toBeGreaterThan(coins);
    // A collection mirrors positions, not operations (ADR 0016): no ledger.
    expect(html).not.toContain('id="operaciones"');
    expect(html).not.toContain("<h3>Traspasar</h3>");
  });

  test("it reads its source's positions, not an operations ledger", async () => {
    await renderedHtml();

    expect(calls.readSourcePositions).toHaveBeenCalledWith("source_numista");
    expect(calls.readOperations).not.toHaveBeenCalled();
    expect(calls.readPositions).not.toHaveBeenCalled();
    // The back-link travels on the asset row; no separate lookup is issued.
    expect(calls.readSourceIdForAsset).not.toHaveBeenCalled();
  });

  test("a collection the v14 backfill filed as `other` still gets this ficha", async () => {
    // The real row (#1691): live source, instrument `other`, so the derivation
    // calls it `stored`. Routed by its instrument it landed on the hand-valued
    // surface — no coin lens, and an instrument picker offering to relabel it.
    calls.readAssets.mockResolvedValue([
      { ...COINS, connectedSourceId: "source_numista", instrument: "other" },
    ]);

    const html = await renderedHtml();

    expect(html).toContain("Sincronizar Numista");
    expect(html).not.toContain('id="operaciones"');
    // The identity is the source's, so nothing here offers to reclassify it.
    expect(html).not.toContain('name="instrument"');
  });
});

describe("EditarPage — the binance family (#1607)", () => {
  beforeEach(() => {
    calls.readAssets.mockResolvedValue([CRYPTO]);
    calls.readSourceIdForAsset.mockResolvedValue("source_binance");
    calls.listSources.mockResolvedValue([
      {
        adapter: "binance",
        assetId: "asset_otro_rung",
        id: "source_binance",
        lastSyncAt: "2026-08-28T09:00:00.000Z",
      },
    ]);
  });

  test("a crypto holding WITH a source mirrors tokens instead of a ledger", async () => {
    const html = await renderedHtml();

    const tokens = html.indexOf("Sincronizar Binance");
    expect(tokens).toBeGreaterThan(-1);
    expect(html.indexOf("<h3>Cobros</h3>")).toBeGreaterThan(tokens);
    expect(html).not.toContain('id="operaciones"');
    // The back-link is the asset's OWN `connected_source_id`, not the source's
    // `asset_id` — a source materializes one asset per rung (#248), and this asset
    // is not the one the source row names. It travels on the row the page already
    // read, so the router needs no extra lookup for it (#1691).
    expect(calls.readSourceIdForAsset).not.toHaveBeenCalled();
    expect(calls.readSourcePositions).toHaveBeenCalledWith("source_binance");
  });

  test("the SAME instrument with no source keeps its hand-written ledger", async () => {
    // The one bit that separates a mirrored holding from a manual crypto
    // position (#248).
    calls.readAssets.mockResolvedValue([{ ...CRYPTO, connectedSourceId: null }]);
    calls.readOperations.mockResolvedValue([OPERATION]);
    calls.readPositions.mockResolvedValue([POSITION]);

    const html = await renderedHtml();

    expect(html).toContain('id="operaciones"');
    expect(html).not.toContain("Sincronizar Binance");
  });
});

/**
 * The debt family (#1848): one describe per model, each pinning its bar and its
 * tabs — the table of the ticket — and what it reads to paint them. The id names a
 * liability here: the asset list is empty.
 */
const MORTGAGE = {
  currency: "EUR",
  currentBalance: { amountMinor: 150_000_00, currency: "EUR" },
  id: ASSET_ID,
  name: "Hipoteca Centro",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "mortgage",
};

const DEBT_PLAN = {
  annualInterestRate: "0.03",
  disbursementDate: "2020-01-15",
  firstPaymentDate: "2020-02-15",
  id: "plan_1",
  initialCapitalMinor: 200_000_00,
  liabilityId: ASSET_ID,
  originalSigningDate: null,
  termMonths: 240,
};

const REVISION = {
  id: "rev_1",
  newAnnualInterestRate: "0.04",
  planId: "plan_1",
  revisionDate: "2023-01-15",
};

const REPAYMENT = {
  amountMinor: 10_000_00,
  id: "rep_1",
  mode: "reduce-payment",
  planId: "plan_1",
  repaymentDate: "2024-03-01",
};

const ANCHOR = {
  anchorDate: "2026-07-01",
  balanceMinor: 1_200_00,
  id: "anchor_1",
  liabilityId: ASSET_ID,
};

describe("EditarPage — the debt family, one ficha per model (#1848)", () => {
  const FICHA = `/patrimonio/${PUBLIC_ID}/editar`;
  const debtBar = (html: string) =>
    html.slice(
      html.indexOf('aria-label="Acciones de la deuda"'),
      html.indexOf('class="fichaFigures"'),
    );
  const tabStrip = (html: string) =>
    html.slice(
      html.indexOf('aria-label="Secciones de la ficha"'),
      html.indexOf('class="fichaTabBody"'),
    );
  /** The bar's buttons in view, by `?accion=`, with the habitual one marked. */
  const shown = (html: string) =>
    [...debtBar(html).matchAll(/class="(btn[^"]*)" data-ficha-action="([^"]+)"/g)].map(
      ([, cls, key]) => (cls === "btn" ? `${key}*` : key),
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"));
    calls.readAssets.mockResolvedValue([]);
    calls.readLiabilities.mockResolvedValue([MORTGAGE]);
  });
  afterEach(() => {
    vi.useRealTimers();
    calls.readLiabilities.mockResolvedValue([]);
    calls.readDebtModel.mockResolvedValue(null);
    calls.readAmortizationPlan.mockResolvedValue(null);
    calls.readInterestRateRevisions.mockResolvedValue([]);
    calls.readEarlyRepayments.mockResolvedValue([]);
    calls.readBalanceAnchors.mockResolvedValue([]);
    calls.readBalanceRebaselines.mockResolvedValue([]);
  });

  describe("amortizable with a plan", () => {
    beforeEach(() => {
      calls.readDebtModel.mockResolvedValue("amortizable");
      calls.readAmortizationPlan.mockResolvedValue(DEBT_PLAN);
      calls.readInterestRateRevisions.mockResolvedValue([REVISION]);
      calls.readEarlyRepayments.mockResolvedValue([REPAYMENT]);
    });

    test("anticipada leads, revision and recalibrar at hand; Plan · Revisiones · Anticipadas · Datos", async () => {
      const html = await renderedHtml();

      expect(shown(html)).toEqual(["anticipada*", "revision", "recalibrar"]);
      expect(debtBar(html)).toContain("data-ficha-more");
      const tabs = tabStrip(html);
      expect(tabs).toMatch(/Plan<\/a>/);
      expect(tabs).toMatch(/Revisiones<span class="fichaTabCount">1</);
      expect(tabs).toMatch(/Anticipadas<span class="fichaTabCount">1</);
      expect(tabs.indexOf("Datos de la deuda")).toBeGreaterThan(
        tabs.indexOf("Anticipadas"),
      );
      // Plan opens by default, with the plan and its cuotas.
      expect(tabBody(html)).toContain("Actualizar plan");
      expect(tabBody(html)).toContain("Cuota habitual");
      // The header: the model, and the cuota in force.
      expect(html).toContain("Amortizable (préstamo francés)");
      expect(html).toContain("Cuota vigente");
      expect(html).toContain('<span class="fichaInstrument">Hipoteca</span>');
    });

    test("each panel returns to the tab its result shows on", async () => {
      expect(panel(await renderedHtml({ accion: "anticipada" }))).toContain(
        `name="currentUrl" value="${FICHA}?pesta%C3%B1a=anticipadas"`,
      );
      expect(panel(await renderedHtml({ accion: "revision" }))).toContain(
        `name="currentUrl" value="${FICHA}?pesta%C3%B1a=revisiones"`,
      );
      // Recalibrar lands on Plan, the bare ficha, with its notice.
      expect(panel(await renderedHtml({ accion: "recalibrar" }))).toContain(
        `name="currentUrl" value="${FICHA}"`,
      );
    });

    test("its tables are tabs, and a refused row edit lands on its tab, unfolded", async () => {
      const revisiones = tabBody(await renderedHtml({ pestaña: "revisiones" }));
      expect(revisiones).toContain('aria-label="Revisiones de tipo"');
      expect(revisiones).toContain("2023-01-15");
      // Inside the debt surfaces' scope: «Editar» reads as a control (blue summary).
      expect(revisiones).toMatch(/class="tableScroll debtRows debtSurface"/);

      const refused = await renderedHtml({
        error: "Tipo no válido.",
        form: "repayment-rep_1",
        v_amount: "mucho",
      });
      expect(tabBody(refused)).toContain('aria-label="Amortizaciones anticipadas"');
      expect(tabBody(refused)).toContain('value="mucho"');
    });

    test("a refused revision reopens its panel and says why there, once", async () => {
      const html = await renderedHtml({
        error: "La fecha no puede ser futura.",
        form: "revision",
        v_revisionDate: "2030-01-01",
      });

      expect(panel(html)).toContain(
        '<h3 id="ficha-panel-title">Registrar revisión de tipo</h3>',
      );
      expect(panel(html)).toContain("La fecha no puede ser futura.");
      expect(html.split("La fecha no puede ser futura.")).toHaveLength(2);
    });

    test("it reads the plan, its re-baselines, its revisions and repayments — no anchors, no cobros", async () => {
      await renderedHtml();

      expect(calls.readAmortizationPlan).toHaveBeenCalledWith(ASSET_ID);
      expect(calls.readBalanceRebaselines).toHaveBeenCalledWith(ASSET_ID);
      expect(calls.readInterestRateRevisions).toHaveBeenCalledWith("plan_1");
      expect(calls.readEarlyRepayments).toHaveBeenCalledWith("plan_1");
      expect(calls.readBalanceAnchors).not.toHaveBeenCalled();
      expect(calls.readPayoutsForHolding).not.toHaveBeenCalled();
      expect(calls.readOperations).not.toHaveBeenCalled();
    });
  });

  describe("amortizable with no curve yet", () => {
    beforeEach(() => {
      calls.readDebtModel.mockResolvedValue("amortizable");
    });

    test("«Actualizar saldo» leads; Plan offers the alta por estado actual", async () => {
      const html = await renderedHtml();

      expect(shown(html)).toEqual(["saldo-pendiente*"]);
      expect(tabStrip(html)).not.toContain("Revisiones");
      expect(tabBody(html)).toContain("Guardar por estado actual");
      expect(html).toContain("Sin plan");
      expect(html).toContain("Configurar el plan");
    });
  });

  describe("revolving", () => {
    beforeEach(() => {
      calls.readDebtModel.mockResolvedValue("revolving");
      calls.readBalanceAnchors.mockResolvedValue([ANCHOR]);
    });

    test("«Registrar saldo» leads; Saldos opens by default with its count", async () => {
      const html = await renderedHtml();

      expect(shown(html)).toEqual(["saldo*"]);
      expect(tabStrip(html)).toMatch(/Saldos<span class="fichaTabCount">1</);
      expect(tabBody(html)).toContain('aria-label="Saldos declarados"');
      expect(html).toContain("Último saldo declarado");
      expect(html).toContain("del 01/07/2026");
      expect(panel(await renderedHtml({ accion: "saldo" }))).toContain(
        `name="currentUrl" value="${FICHA}"`,
      );
    });

    test("it reads its anchors and its cadence — no plan", async () => {
      await renderedHtml();

      expect(calls.readBalanceAnchors).toHaveBeenCalledWith(ASSET_ID);
      expect(calls.readDebtValuationCadence).toHaveBeenCalledWith(ASSET_ID);
      expect(calls.readAmortizationPlan).not.toHaveBeenCalled();
      expect(calls.readBalanceRebaselines).not.toHaveBeenCalled();
    });

    test("the model and its cadence live in «Modelo de deuda»", async () => {
      const modelo = panel(await renderedHtml({ accion: "modelo" }));

      expect(modelo).toContain('<h3 id="ficha-panel-title">Modelo de deuda</h3>');
      expect(modelo).toContain('name="debtModel"');
      expect(modelo).toContain("Cadencia de valoración");
    });
  });

  describe("informal with no balance yet", () => {
    beforeEach(() => {
      calls.readDebtModel.mockResolvedValue("informal");
    });

    test("it says so in the header", async () => {
      const html = await renderedHtml();

      expect(html).toContain("Sin saldos declarados");
      expect(tabBody(html)).toContain("Sin saldos declarados.");
    });
  });

  describe("no model", () => {
    test("«Elegir modelo» leads, «Actualizar saldo» beside it, and only «Datos de la deuda»", async () => {
      const html = await renderedHtml();

      expect(shown(html)).toEqual(["modelo*", "saldo-pendiente"]);
      expect(debtBar(html)).toContain("Elegir modelo");
      expect(debtBar(html)).not.toContain("data-ficha-more");
      expect(tabStrip(html)).toContain("Datos de la deuda");
      expect(tabStrip(html)).not.toContain("Plan");
      expect(html).toContain("Sin modelo");
      expect(tabBody(html)).toContain("Lo básico");
    });

    test("it reads the model and its cadence, and nothing else of the debt", async () => {
      await renderedHtml();

      expect(calls.readDebtModel).toHaveBeenCalledWith(ASSET_ID);
      expect(calls.readAmortizationPlan).not.toHaveBeenCalled();
      expect(calls.readBalanceAnchors).not.toHaveBeenCalled();
      expect(calls.readInterestRateRevisions).not.toHaveBeenCalled();
    });
  });
});
