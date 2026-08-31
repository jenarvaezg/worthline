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
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
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

async function renderedHtml(): Promise<string> {
  const element = (await EditarPage({
    params: Promise.resolve({ id: PUBLIC_ID }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

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
  });

  test("renders every surface a market investment owns, in its own order", async () => {
    const html = await renderedHtml();

    // The ledger and everything downstream of it.
    expect(html).toContain("Rentabilidad");
    expect(html).toContain("<h3>Operaciones</h3>");
    expect(html).toContain("<h3>Traspasar</h3>");
    expect(html).toContain("<h3>Cargar movimientos</h3>");
    expect(html).toContain("<h3>Corregir precio de un día</h3>");
    // The per-holding provider refresh (#406) — only offered with a symbol.
    expect(html).toContain("Actualizar precio");
    // Cobros rides on every asset, and sits AFTER the ledger surfaces.
    expect(html.indexOf("<h3>Cobros</h3>")).toBeGreaterThan(
      html.indexOf("<h3>Operaciones</h3>"),
    );
    // …and the shared chrome is still around it.
    expect(html).toContain("Lo básico");
    expect(html).toContain("Zona de peligro");
  });

  test("the record and delete actions are still bound to this holding", async () => {
    const html = await renderedHtml();

    // Every form posts the return-here URL built from the PUBLIC id (#1318), and
    // the delete carries the operation's own id.
    expect(html).toContain(`value="/patrimonio/${PUBLIC_ID}/editar"`);
    expect(html).toContain('value="op_1"');
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
    expect(html).not.toContain("<h3>Operaciones</h3>");
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
    expect(html).not.toContain("<h3>Operaciones</h3>");
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
    expect(html).not.toContain("<h3>Operaciones</h3>");
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
    expect(html).not.toContain("<h3>Operaciones</h3>");
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
    expect(html).not.toContain("<h3>Operaciones</h3>");
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

    expect(html).toContain("<h3>Operaciones</h3>");
    expect(html).not.toContain("Sincronizar Binance");
  });
});
