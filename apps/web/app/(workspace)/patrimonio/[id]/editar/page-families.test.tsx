import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

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
  liquidityTier: "liquid",
  name: "Cuenta nómina",
  ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
  type: "cash",
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
  readDebtModel: vi.fn(async (): Promise<string | null> => null),
  readLiabilities: vi.fn(async (): Promise<unknown[]> => []),
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
        agentView: { readPublicIds: calls.readPublicIds },
        assets: {
          readAcquisitionCostMinor: calls.readAcquisitionCostMinor,
          readAnnualAppreciationRate: calls.readAnnualAppreciationRate,
          readAssets: calls.readAssets,
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
          readDebtModel: calls.readDebtModel,
          readLiabilities: calls.readLiabilities,
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
    expect(html).toContain("100 × 120 €");
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
    expect(cobros).toContain("Renta pasiva");
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

  test("the Rentabilidad tab measures what the header measures", async () => {
    const html = await renderedHtml({ pestaña: "rentabilidad" });

    // The same fold, the same 2.000 €: the panel and the header cannot disagree.
    expect(tabBody(html)).toMatch(/2\.?000\s€/);
  });
});

describe("EditarPage — the stored family (#1607)", () => {
  beforeEach(() => {
    calls.readAssets.mockResolvedValue([CASH]);
  });

  test("a cash account shows its basics, its cobros and its danger zone — nothing else", async () => {
    const html = await renderedHtml();

    expect(html).toContain("Lo básico");
    expect(html).toContain("Zona de peligro");
    // Cobros lands INSIDE the «Configuración avanzada» accordion — the anchor the
    // assistant's rent destination quotes (#1524), and the one thing a family
    // could silently break by placing the shared panel outside its own body.
    const body = html.indexOf('<div class="editAdvancedBody">');
    expect(html.indexOf("<h3>Cobros</h3>")).toBeGreaterThan(body);
    expect(html.indexOf("<h3>Cobros</h3>")).toBeLessThan(html.indexOf("</details>"));
    // No ledger, no valuation curve, no debt model.
    expect(html).not.toContain('id="operaciones"');
    expect(html).not.toContain("<h3>Traspasar</h3>");
    expect(html).not.toContain("<h3>Valoración del inmueble</h3>");
    expect(html).not.toContain("<h3>Modelo de deuda</h3>");
  });

  test("it loads only what it paints", async () => {
    await renderedHtml();

    // The whole point of the family split: a cash account issues the payout
    // reads its Cobros panel needs, the cash-container gate its danger zone
    // needs (ADR 0085) — and not one row of a ledger, a curve or a debt.
    expect(calls.readPayoutsForHolding).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.readCashContainerName).toHaveBeenCalledWith(ASSET_ID);
    expect(calls.readOperations).not.toHaveBeenCalled();
    expect(calls.readPositions).not.toHaveBeenCalled();
    expect(calls.readSnapshotHoldings).not.toHaveBeenCalled();
    expect(calls.readInvestmentAssetById).not.toHaveBeenCalled();
    expect(calls.readValuationAnchors).not.toHaveBeenCalled();
    expect(calls.readDebtModel).not.toHaveBeenCalled();
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
