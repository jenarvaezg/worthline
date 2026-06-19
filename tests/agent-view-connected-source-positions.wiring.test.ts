import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";

import { createWorthlineStore } from "@worthline/db";
import type { SourcePositionInput } from "@worthline/db";
import { GET as getScopes } from "../apps/web/app/api/v1/agent-view/scopes/route";
import { GET as getFinancialContext } from "../apps/web/app/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getHoldingPositions } from "../apps/web/app/api/v1/agent-view/holdings/[holdingId]/connected-source-positions/route";
import { GET as getSourcePositions } from "../apps/web/app/api/v1/agent-view/connected-sources/[sourceId]/positions/route";
import { createAgentViewMcpToolCatalog } from "../apps/web/app/agent-view/mcp";
import type { AgentViewApiClient } from "../apps/web/app/agent-view/mcp";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

const ORIGINAL_DB_PATH = process.env.WORTHLINE_DB_PATH;
const ORIGINAL_TOKEN = process.env.WORTHLINE_AGENT_VIEW_TOKEN;

const NUMISTA_SECRET = "numista-secret-key-zzz";
const BINANCE_KEY = "binance-key-aaa";
const BINANCE_SECRET = "binance-secret-bbb";

afterEach(() => {
  if (ORIGINAL_DB_PATH === undefined) {
    delete process.env.WORTHLINE_DB_PATH;
  } else {
    process.env.WORTHLINE_DB_PATH = ORIGINAL_DB_PATH;
  }

  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.WORTHLINE_AGENT_VIEW_TOKEN;
  } else {
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = ORIGINAL_TOKEN;
  }

  cleanupTempDirs();
});

function eur(amountMinor: number) {
  return { amountMinor, currency: "EUR" };
}

function authedRequest(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1${path}`, {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

interface ScopeRef {
  id: string;
  type: string;
}

async function householdScopeId(): Promise<string> {
  const body = await (await getScopes(authedRequest("/api/v1/agent-view/scopes"))).json();
  return (body.data as ScopeRef[]).find((scope) => scope.type === "household")!.id;
}

interface SourceSummary {
  id: string;
  object: string;
  adapter: string;
  label: string;
  lastSyncAt: string | null;
  freshness: {
    status: string;
    lastSuccessfulSyncAt?: string;
    lastFailedSync?: { at: string; reason?: string };
  };
  projectedHoldings: Array<{ id: string; object: string; label: string }>;
}

async function financialContextBody(scopeId: string) {
  const response = await getFinancialContext(
    authedRequest(`/api/v1/agent-view/scopes/${scopeId}/financial-context`),
    { params: Promise.resolve({ scopeId }) },
  );
  return response.json();
}

async function connectedSourceSummaries(): Promise<SourceSummary[]> {
  const body = await financialContextBody(await householdScopeId());
  return body.data.connectedSources as SourceSummary[];
}

async function holdingPositions(holdingId: string, query = "") {
  const response = await getHoldingPositions(
    authedRequest(
      `/api/v1/agent-view/holdings/${holdingId}/connected-source-positions${query}`,
    ),
    { params: Promise.resolve({ holdingId }) },
  );
  return { body: await response.json(), response };
}

async function sourcePositions(sourceId: string, query = "") {
  const response = await getSourcePositions(
    authedRequest(`/api/v1/agent-view/connected-sources/${sourceId}/positions${query}`),
    { params: Promise.resolve({ sourceId }) },
  );
  return { body: await response.json(), response };
}

interface SourceIds {
  numistaSourcePublicId: string;
  binanceSourcePublicId: string;
  numistaHoldingPublicId: string;
  binanceHoldingPublicId: string;
}

/** Resolve the public source + holding ids from the financial context. */
async function resolveIds(): Promise<SourceIds> {
  const sources = await connectedSourceSummaries();
  const numista = sources.find((s) => s.adapter === "numista")!;
  const binance = sources.find((s) => s.adapter === "binance")!;
  return {
    binanceHoldingPublicId: binance.projectedHoldings[0]!.id,
    binanceSourcePublicId: binance.id,
    numistaHoldingPublicId: numista.projectedHoldings[0]!.id,
    numistaSourcePublicId: numista.id,
  };
}

const coin = (
  overrides: Partial<Extract<SourcePositionInput, { kind: "coin" }>> = {},
): SourcePositionInput => ({
  catalogueId: "n1",
  currency: "EUR",
  externalId: "coin-1",
  finenessMillis: null,
  grade: "VF",
  issueId: null,
  kind: "coin",
  liquidityTier: "illiquid",
  metal: "silver",
  metalValueMinor: null,
  name: "8 reales",
  numismaticFetchedAt: null,
  numismaticValueMinor: null,
  obverseThumbUrl: null,
  purchaseDate: "2024-01-01",
  purchasePriceMinor: null,
  quantity: 1,
  weightGrams: null,
  year: null,
  ...overrides,
});

const token = (
  overrides: Partial<Extract<SourcePositionInput, { kind: "token" }>> = {},
): SourcePositionInput => ({
  balance: "0.5",
  currency: "EUR",
  externalId: "BTC:spot",
  kind: "token",
  liquidityTier: "market",
  name: "BTC",
  symbol: "BTC",
  unitPrice: "50000",
  wallet: "spot",
  ...overrides,
});

/**
 * Seed a household with a Numista source (two coins, one metal-valued and one
 * numismatic-valued) and a Binance source (a priced BTC and an unpriced token),
 * then sync positions. Numista is also revalued so it carries a freshness row.
 */
function seedSources(): void {
  const databasePath = tempDatabasePath("worthline-agent-view-csp-");
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = createWorthlineStore({ databasePath });
  store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

  const numista = store.connectedSources.connect({
    adapter: "numista",
    credentialsJson: JSON.stringify({ apiKey: NUMISTA_SECRET }),
    label: "Colección Numista",
    ownership: owner,
  });
  store.connectedSources.syncPositions(
    numista.sourceId,
    [
      coin({
        catalogueId: "1493",
        externalId: "coin-eagle",
        metal: "gold",
        metalValueMinor: 80_000,
        name: "Águila de oro",
        numismaticValueMinor: 60_000,
      }),
      coin({
        catalogueId: "5678",
        externalId: "coin-peseta",
        metal: "silver",
        metalValueMinor: 1_000,
        name: "Duro de plata",
        numismaticValueMinor: 4_000,
      }),
    ],
    "2026-06-15T12:00:00.000Z",
  );
  const coins = store.connectedSources.readPositions(numista.sourceId);
  store.connectedSources.revaluePositions(
    numista.sourceId,
    coins.map((position) => ({
      id: position.id,
      metalValueMinor: position.kind === "coin" ? position.metalValueMinor : null,
      numismaticFetchedAt: "2026-06-16T09:00:00.000Z",
      numismaticValueMinor:
        position.kind === "coin" ? position.numismaticValueMinor : null,
    })),
    { fetchedAt: "2026-06-16T09:00:00.000Z", freshnessState: "fresh" },
  );

  const binance = store.connectedSources.connect({
    adapter: "binance",
    credentialsJson: JSON.stringify({ apiKey: BINANCE_KEY, apiSecret: BINANCE_SECRET }),
    label: "Binance",
    ownership: owner,
  });
  store.connectedSources.syncPositions(
    binance.sourceId,
    [
      token({
        balance: "0.5",
        externalId: "BTC:spot",
        symbol: "BTC",
        unitPrice: "50000",
      }),
      token({
        balance: "100",
        externalId: "SHIB:spot",
        name: "SHIB",
        symbol: "SHIB",
        unitPrice: null,
      }),
    ],
    "2026-06-16T10:00:00.000Z",
  );
  store.close();
}

// Route the MCP client to the real handlers so MCP output is proven against the
// HTTP contract.
const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = authedRequest(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/agent-view/scopes") {
      return (await (await getScopes(req)).json()) as T;
    }

    const holdingMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/holdings\/([^/]+)\/connected-source-positions$/,
    );
    if (holdingMatch) {
      const holdingId = decodeURIComponent(holdingMatch[1]!);
      const response = await getHoldingPositions(req, {
        params: Promise.resolve({ holdingId }),
      });
      return (await response.json()) as T;
    }

    const sourceMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/connected-sources\/([^/]+)\/positions$/,
    );
    if (sourceMatch) {
      const sourceId = decodeURIComponent(sourceMatch[1]!);
      const response = await getSourcePositions(req, {
        params: Promise.resolve({ sourceId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

describe("connected-source summaries in the financial context", () => {
  test("extends each source summary with id, adapter, freshness, and projected holdings", async () => {
    seedSources();
    const sources = await connectedSourceSummaries();

    const numista = sources.find((s) => s.adapter === "numista")!;
    expect(numista.id).toMatch(/^wl_src_[a-f0-9]{32}$/);
    expect(numista.object).toBe("connected_source");
    expect(numista.label).toBe("Colección Numista");
    expect(numista.lastSyncAt).toBe("2026-06-15T12:00:00.000Z");
    expect(numista.projectedHoldings[0]!.id).toMatch(/^wl_hld_/);
    // Revalued source carries a fresh freshness signal + the last successful sync.
    expect(numista.freshness.status).toBe("fresh");
    expect(numista.freshness.lastSuccessfulSyncAt).toBe("2026-06-15T12:00:00.000Z");
    expect(numista.freshness.lastFailedSync).toBeUndefined();

    const binance = sources.find((s) => s.adapter === "binance")!;
    expect(binance.id).toMatch(/^wl_src_/);
    // Binance synced but was never revalued → no freshness row yet.
    expect(binance.freshness.status).toBe("unknown");
    expect(binance.freshness.lastSuccessfulSyncAt).toBe("2026-06-16T10:00:00.000Z");
  });

  test("reports a failed/stale signal as lastFailedSync with its reason", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-csp-stale-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    const numista = store.connectedSources.connect({
      adapter: "numista",
      credentialsJson: JSON.stringify({ apiKey: NUMISTA_SECRET }),
      label: "Colección Numista",
      ownership: owner,
    });
    store.connectedSources.syncPositions(
      numista.sourceId,
      [coin({ externalId: "coin-eagle", numismaticValueMinor: 7_558 })],
      "2026-06-15T12:00:00.000Z",
    );
    const eagle = store.connectedSources.readPositions(numista.sourceId)[0]!;
    store.connectedSources.revaluePositions(
      numista.sourceId,
      [
        {
          id: eagle.id,
          metalValueMinor: null,
          numismaticFetchedAt: null,
          numismaticValueMinor: 7_558,
        },
      ],
      {
        fetchedAt: "2026-06-16T09:00:00.000Z",
        freshnessState: "stale",
        staleReason: "Numista no disponible",
      },
    );
    store.close();

    const sources = await connectedSourceSummaries();
    const numistaSummary = sources.find((s) => s.adapter === "numista")!;
    expect(numistaSummary.freshness.status).toBe("stale");
    expect(numistaSummary.freshness.lastFailedSync).toEqual({
      at: "2026-06-16T09:00:00.000Z",
      reason: "Numista no disponible",
    });
  });

  test("never serializes the source credential secret in the summary", async () => {
    seedSources();
    const sources = await connectedSourceSummaries();
    const serialized = JSON.stringify(sources);
    expect(serialized).not.toContain(NUMISTA_SECRET);
    expect(serialized).not.toContain(BINANCE_KEY);
    expect(serialized).not.toContain(BINANCE_SECRET);
  });
});

describe("GET /api/v1/agent-view/holdings/{holdingId}/connected-source-positions", () => {
  test("returns the Numista coin positions for the connected holding", async () => {
    seedSources();
    const { numistaHoldingPublicId } = await resolveIds();

    const { body, response } = await holdingPositions(numistaHoldingPublicId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const positions = body.data as Array<{
      id: string;
      object: string;
      kind: string;
      adapter: string;
      sourceLabel: string;
      projectedHolding: { id: string; object: string };
      liquidityTier: string;
      label: string;
      groupKey: string | null;
      quantity: string;
      value: { amountMinor: number; currency: string };
      valuationBasis: string;
      qualitySignals: string[];
    }>;

    expect(positions).toHaveLength(2);
    for (const position of positions) {
      expect(position.id).toMatch(/^wl_pos_[a-f0-9]{32}$/);
      expect(position.object).toBe("connected_source_position");
      expect(position.kind).toBe("coin");
      expect(position.adapter).toBe("numista");
      expect(position.sourceLabel).toBe("Colección Numista");
      expect(position.projectedHolding.id).toBe(numistaHoldingPublicId);
      expect(position.liquidityTier).toBe("illiquid");
    }

    const eagle = positions.find((p) => p.label === "Águila de oro")!;
    expect(eagle.groupKey).toBe("gold");
    expect(eagle.quantity).toBe("1");
    // max(metal 80_000, numismatic 60_000) → metal basis.
    expect(eagle.value).toEqual(eur(80_000));
    expect(eagle.valuationBasis).toBe("metal");
    expect(eagle.qualitySignals).toEqual([]);

    const peseta = positions.find((p) => p.label === "Duro de plata")!;
    // max(metal 1_000, numismatic 4_000) → numismatic basis.
    expect(peseta.value).toEqual(eur(4_000));
    expect(peseta.valuationBasis).toBe("numismatic");

    expect(body.meta.limit).toBe(100);
    expect(body.meta.hasNext).toBe(false);
    expect(body.links.self).toBe(
      `/api/v1/agent-view/holdings/${numistaHoldingPublicId}/connected-source-positions`,
    );
  });

  test("returns Binance token positions priced live, with valuation basis and freshness", async () => {
    seedSources();
    const { binanceHoldingPublicId } = await resolveIds();

    const { body } = await holdingPositions(binanceHoldingPublicId);
    const positions = body.data as Array<{
      kind: string;
      label: string;
      groupKey: string | null;
      quantity: string;
      unitPrice?: string;
      value: { amountMinor: number };
      valuationBasis: string;
      qualitySignals: string[];
      freshness?: unknown;
    }>;

    expect(positions).toHaveLength(2);

    const btc = positions.find((p) => p.label === "BTC")!;
    expect(btc.kind).toBe("token");
    expect(btc.groupKey).toBe("BTC");
    expect(btc.quantity).toBe("0.5");
    expect(btc.unitPrice).toBe("50000");
    // 0.5 × 50_000 = 25_000 € = 2_500_000 minor.
    expect(btc.value).toEqual(eur(2_500_000));
    expect(btc.valuationBasis).toBe("market");
    expect(btc.qualitySignals).toEqual([]);

    // The unpriced token is reported at value 0 with a quality signal (#339).
    const shib = positions.find((p) => p.label === "SHIB")!;
    expect(shib.unitPrice).toBeUndefined();
    expect(shib.value).toEqual(eur(0));
    expect(shib.valuationBasis).toBe("unvalued");
    expect(shib.qualitySignals.length).toBeGreaterThan(0);
  });

  test("paginates with stable cursors, walking every position exactly once", async () => {
    seedSources();
    const { numistaSourcePublicId } = await resolveIds();

    const first = await sourcePositions(numistaSourcePublicId, "?limit=1");
    const seen: string[] = (
      first.body.data as Array<{ positions: Array<{ id: string }> }>
    ).flatMap((group) => group.positions.map((p) => p.id));
    expect(seen).toHaveLength(1);
    expect(first.body.meta.hasNext).toBe(true);

    let cursor: string | undefined = first.body.meta.nextCursor;
    let guard = 0;
    while (cursor && guard++ < 10) {
      const page = await sourcePositions(
        numistaSourcePublicId,
        `?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      seen.push(
        ...(page.body.data as Array<{ positions: Array<{ id: string }> }>).flatMap(
          (group) => group.positions.map((p) => p.id),
        ),
      );
      cursor = page.body.meta.hasNext ? page.body.meta.nextCursor : undefined;
    }

    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
  });

  test("a manual (non-connected) holding → 422 unprocessable_entity", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-csp-manual-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    store.close();

    const scopeId = await householdScopeId();
    const body = await financialContextBody(scopeId);
    const cashId = (
      body.data.holdings.items as Array<{ id: string; label: string }>
    ).find((h) => h.label === "Cuenta")!.id;

    const { body: errBody, response } = await holdingPositions(cashId);
    expect(response.status).toBe(422);
    expect(errBody.error.code).toBe("unprocessable_entity");
  });

  test("unknown holding id → 404 not_found", async () => {
    seedSources();
    const { body, response } = await holdingPositions("wl_hld_doesnotexist");
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("never serializes source secrets in the position response", async () => {
    seedSources();
    const { numistaHoldingPublicId, binanceHoldingPublicId } = await resolveIds();

    const numistaSerialized = JSON.stringify(
      (await holdingPositions(numistaHoldingPublicId)).body,
    );
    const binanceSerialized = JSON.stringify(
      (await holdingPositions(binanceHoldingPublicId)).body,
    );
    for (const serialized of [numistaSerialized, binanceSerialized]) {
      expect(serialized).not.toContain(NUMISTA_SECRET);
      expect(serialized).not.toContain(BINANCE_KEY);
      expect(serialized).not.toContain(BINANCE_SECRET);
    }
  });

  test("position public ids are stable across a re-sync (externalId-derived)", async () => {
    seedSources();
    const { numistaHoldingPublicId } = await resolveIds();

    const before = (await holdingPositions(numistaHoldingPublicId)).body.data as Array<{
      id: string;
      label: string;
    }>;

    // Re-sync the SAME externalIds (worthline reassigns internal ids each sync).
    const databasePath = process.env.WORTHLINE_DB_PATH as string;
    const store = createWorthlineStore({ databasePath });
    const numista = store.connectedSources
      .listSources()
      .find((s) => s.adapter === "numista")!;
    store.connectedSources.syncPositions(
      numista.id,
      [
        coin({
          catalogueId: "1493",
          externalId: "coin-eagle",
          metal: "gold",
          metalValueMinor: 80_000,
          name: "Águila de oro",
          numismaticValueMinor: 60_000,
        }),
        coin({
          catalogueId: "5678",
          externalId: "coin-peseta",
          metal: "silver",
          metalValueMinor: 1_000,
          name: "Duro de plata",
          numismaticValueMinor: 4_000,
        }),
      ],
      "2026-06-17T12:00:00.000Z",
    );
    store.close();

    const after = (await holdingPositions(numistaHoldingPublicId)).body.data as Array<{
      id: string;
      label: string;
    }>;

    const idByLabel = (rows: Array<{ id: string; label: string }>) =>
      Object.fromEntries(rows.map((r) => [r.label, r.id]));
    expect(idByLabel(after)).toEqual(idByLabel(before));
  });
});

describe("GET /api/v1/agent-view/connected-sources/{sourceId}/positions", () => {
  test("returns all of a source's positions grouped by projected holding/rung", async () => {
    seedSources();
    const { numistaSourcePublicId, numistaHoldingPublicId } = await resolveIds();

    const { body, response } = await sourcePositions(numistaSourcePublicId);
    expect(response.status).toBe(200);

    const groups = body.data as Array<{
      projectedHolding: { id: string; object: string };
      liquidityTier: string;
      groupValue: { amountMinor: number; currency: string };
      positions: Array<{ label: string; value: { amountMinor: number } }>;
    }>;

    expect(groups).toHaveLength(1);
    expect(groups[0]!.projectedHolding.id).toBe(numistaHoldingPublicId);
    expect(groups[0]!.liquidityTier).toBe("illiquid");
    // 80_000 (eagle) + 4_000 (peseta).
    expect(groups[0]!.groupValue).toEqual(eur(84_000));
    expect(groups[0]!.positions).toHaveLength(2);
  });

  test("unknown source id → 404 not_found", async () => {
    seedSources();
    const { body, response } = await sourcePositions("wl_src_doesnotexist");
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("rejects unknown query parameters and invalid limits", async () => {
    seedSources();
    const { numistaSourcePublicId } = await resolveIds();

    expect(
      (await sourcePositions(numistaSourcePublicId, "?nope=1")).response.status,
    ).toBe(400);
    expect(
      (await sourcePositions(numistaSourcePublicId, "?limit=0")).response.status,
    ).toBe(400);
    expect(
      (await sourcePositions(numistaSourcePublicId, "?limit=abc")).response.status,
    ).toBe(400);

    const clamped = await sourcePositions(numistaSourcePublicId, "?limit=9999");
    expect(clamped.response.status).toBe(200);
    expect(clamped.body.meta.limit).toBe(500);
  });

  test("requires the local capability token", async () => {
    seedSources();
    const { numistaSourcePublicId } = await resolveIds();

    const response = await getSourcePositions(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/connected-sources/${numistaSourcePublicId}/positions`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ sourceId: numistaSourcePublicId }) },
    );
    expect(response.status).toBe(401);
  });
});

describe("MCP get_connected_source_positions", () => {
  test("holding-scoped form mirrors the HTTP shape", async () => {
    seedSources();
    const { numistaHoldingPublicId } = await resolveIds();
    const httpBody = (await holdingPositions(numistaHoldingPublicId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_connected_source_positions.invoke({
      holdingId: numistaHoldingPublicId,
    });

    expect(mcpBody).toEqual(httpBody);
  });

  test("source-scoped form mirrors the HTTP shape", async () => {
    seedSources();
    const { numistaSourcePublicId } = await resolveIds();
    const httpBody = (await sourcePositions(numistaSourcePublicId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_connected_source_positions.invoke({
      sourceId: numistaSourcePublicId,
    });

    expect(mcpBody).toEqual(httpBody);
  });

  test("supplying both holdingId and sourceId → 422 unprocessable_entity", async () => {
    seedSources();
    const { numistaHoldingPublicId, numistaSourcePublicId } = await resolveIds();

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const result = (await catalog.get_connected_source_positions.invoke({
      holdingId: numistaHoldingPublicId,
      sourceId: numistaSourcePublicId,
    })) as { error?: { code: string } };

    expect(result.error?.code).toBe("unprocessable_entity");
  });

  test("supplying neither selector → 422 unprocessable_entity", async () => {
    seedSources();

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const result = (await catalog.get_connected_source_positions.invoke({})) as {
      error?: { code: string };
    };

    expect(result.error?.code).toBe("unprocessable_entity");
  });

  test("a holding not backed by a connected source → 422 via MCP", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-csp-mcp-manual-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    store.close();

    const scopeId = await householdScopeId();
    const body = await financialContextBody(scopeId);
    const cashId = (
      body.data.holdings.items as Array<{ id: string; label: string }>
    ).find((h) => h.label === "Cuenta")!.id;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const result = (await catalog.get_connected_source_positions.invoke({
      holdingId: cashId,
    })) as { error?: { code: string } };

    expect(result.error?.code).toBe("unprocessable_entity");
  });
});

describe("connected-source position reads are side-effect-free", () => {
  test("reads do not mutate positions, price cache, sources, or public ids", async () => {
    seedSources();
    const databasePath = process.env.WORTHLINE_DB_PATH as string;
    const { numistaHoldingPublicId, numistaSourcePublicId, binanceHoldingPublicId } =
      await resolveIds();

    const before = fingerprint(databasePath);
    await holdingPositions(numistaHoldingPublicId);
    await holdingPositions(binanceHoldingPublicId);
    await sourcePositions(numistaSourcePublicId);
    await sourcePositions(numistaSourcePublicId, "?limit=1");
    await connectedSourceSummaries();
    const after = fingerprint(databasePath);

    expect(after).toBe(before);
  });
});

// A fingerprint of every mutation-prone read, to prove a position read writes
// nothing (no positions re-synced, no price cache, no sources, no public IDs).
function fingerprint(databasePath: string): string {
  const store = createWorthlineStore({ databasePath });
  const sources = store.connectedSources.listSources();
  const snapshot = JSON.stringify({
    assets: store.assets.readAssets(),
    positions: sources.map((source) => ({
      positions: store.connectedSources.readPositions(source.id),
      sourceId: source.id,
    })),
    priceCache: store.operations.readAllPriceCacheEntries(),
    publicIds: store.agentView.readPublicIds(),
    sources,
  });
  store.close();
  return snapshot;
}
