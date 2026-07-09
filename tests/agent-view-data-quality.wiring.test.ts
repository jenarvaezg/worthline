import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getDataQuality } from "@web/api/v1/agent-view/scopes/[scopeId]/data-quality/route";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStore } from "@worthline/db";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

const ORIGINAL_DB_PATH = process.env.WORTHLINE_DB_PATH;
const ORIGINAL_TOKEN = process.env.WORTHLINE_AGENT_VIEW_TOKEN;

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

function authedRequest(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1${path}`, {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

interface ScopeRef {
  id: string;
  type: string;
  label: string;
}

async function listScopes(): Promise<ScopeRef[]> {
  const body = await (await getScopes(authedRequest("/api/v1/agent-view/scopes"))).json();
  return body.data as ScopeRef[];
}

async function householdScopeId(): Promise<string> {
  const scopes = await listScopes();
  return scopes.find((scope) => scope.type === "household")!.id;
}

interface Signal {
  id: string;
  object: string;
  category: string;
  severity: string;
  label: string;
  code: string;
  fixable: boolean;
  affected?: { id: string; object: string; label: string };
  observedDate?: string;
  originalWarningType?: string;
}

async function dataQuality(scopeId: string, query = "") {
  const response = await getDataQuality(
    authedRequest(`/api/v1/agent-view/scopes/${scopeId}/data-quality${query}`),
    { params: Promise.resolve({ scopeId }) },
  );
  return { body: await response.json(), response };
}

async function financialContext(scopeId: string, query = "") {
  const response = await getFinancialContext(
    authedRequest(`/api/v1/agent-view/scopes/${scopeId}/financial-context${query}`),
    { params: Promise.resolve({ scopeId }) },
  );
  return { body: await response.json(), response };
}

async function signals(scopeId: string, query = ""): Promise<Signal[]> {
  return (await dataQuality(scopeId, query)).body.data as Signal[];
}

// A fingerprint of every mutation-prone read, including the warning overrides, to
// prove a data-quality read writes nothing — and crucially, NO override.
async function fingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStore({ databasePath });
  const sources = await store.connectedSources.listSources();
  const snapshot = JSON.stringify({
    assets: await store.assets.readAssets(),
    fireConfig: await store.readFireConfig(),
    liabilities: await store.liabilities.readLiabilities(),
    positions: await Promise.all(
      sources.map(async (source) => ({
        positions: await store.connectedSources.readPositions(source.id),
        sourceId: source.id,
      })),
    ),
    priceCache: await store.operations.readAllPriceCacheEntries(),
    publicIds: await store.agentView.readPublicIds(),
    snapshots: await store.snapshots.readSnapshots("household"),
    sources,
    warningOverrides: await store.readWarningOverrides(),
  });
  store.close();
  return snapshot;
}

// Route the MCP client to the real handlers so MCP output is proven against the
// HTTP contract rather than a hand-written double.
const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = authedRequest(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/agent-view/scopes") {
      return (await (await getScopes(req)).json()) as T;
    }

    const dqMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/data-quality$/,
    );
    if (dqMatch) {
      const scopeId = decodeURIComponent(dqMatch[1]!);
      const response = await getDataQuality(req, {
        params: Promise.resolve({ scopeId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

/**
 * Seed a household that triggers every category at least once:
 *  - warning: a zero-value stored asset (ZERO_VALUE_ASSET, overrideable).
 *  - price_freshness: a stale-priced and a failed-priced asset.
 *  - source_freshness: a connected source with a stale last sync.
 *  - missing_configuration: no FIRE config + a mortgage with no debt model.
 *  - history_coverage: no snapshots for the scope.
 *  - projection_gap: an unpriced Binance token (null unitPrice).
 */
async function seedAllCategories(prefix = "worthline-agent-view-dq-"): Promise<string> {
  const databasePath = tempDatabasePath(prefix);
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStore({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

  // warning: a stored asset left at value 0 → ZERO_VALUE_ASSET (overrideable).
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 0,
    id: "asset_zero",
    liquidityTier: "illiquid",
    name: "Cuadro sin tasar",
    ownership: owner,
    type: "manual",
  });

  // price_freshness: two priced assets, one stale, one failed.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 5_000_00,
    id: "asset_stale",
    liquidityTier: "market",
    name: "Fondo viejo",
    ownership: owner,
    type: "manual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 3_000_00,
    id: "asset_failed",
    liquidityTier: "market",
    name: "Fondo roto",
    ownership: owner,
    type: "manual",
  });
  await store.operations.upsertPrice({
    assetId: "asset_stale",
    currency: "EUR",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    freshnessState: "stale",
    price: "100",
    source: "yahoo",
    staleReason: "Precio caducado",
  });
  await store.operations.upsertPrice({
    assetId: "asset_failed",
    currency: "EUR",
    fetchedAt: "2026-02-01T00:00:00.000Z",
    freshnessState: "failed",
    price: "200",
    source: "yahoo",
    staleReason: "Proveedor caído",
  });

  // missing_configuration: a mortgage on a home, with no debt model declared.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 200_000_00,
    id: "asset_home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: owner,
    type: "real_estate",
  });
  await store.liabilities.createLiability({
    associatedAssetId: "asset_home",
    balanceMinor: 100_000_00,
    currency: "EUR",
    id: "liab_mortgage",
    name: "Hipoteca",
    ownership: owner,
    type: "mortgage",
  });

  // source_freshness + projection_gap: a Binance source with a stale freshness
  // and an unpriced token.
  const binance = await store.connectedSources.connect({
    adapter: "binance",
    credentialsJson: JSON.stringify({ apiKey: "k", apiSecret: "s" }),
    label: "Binance",
    ownership: owner,
  });
  await store.connectedSources.syncPositions(
    binance.sourceId,
    [
      {
        balance: "100",
        currency: "EUR",
        externalId: "SHIB:spot",
        kind: "token",
        liquidityTier: "market",
        name: "SHIB",
        symbol: "SHIB",
        unitPrice: null,
        wallet: "spot",
      },
    ],
    "2026-06-16T10:00:00.000Z",
  );
  const positions = await store.connectedSources.readPositions(binance.sourceId);
  await store.connectedSources.revaluePositions(
    binance.sourceId,
    positions.map((position) => ({
      id: position.id,
      metalValueMinor: null,
      numismaticFetchedAt: null,
      numismaticValueMinor: null,
    })),
    {
      fetchedAt: "2026-06-17T09:00:00.000Z",
      freshnessState: "stale",
      staleReason: "Binance no disponible",
    },
  );

  // No FIRE config saved, no snapshots captured → missing_configuration +
  // history_coverage signals.
  store.close();
  return databasePath;
}

describe("GET /api/v1/agent-view/scopes/{scopeId}/data-quality", () => {
  test("surfaces at least one signal in every category", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const categories = new Set(
      (await signals(scopeId, "?limit=500")).map((s) => s.category),
    );

    expect(categories).toEqual(
      new Set([
        "warning",
        "price_freshness",
        "source_freshness",
        "missing_configuration",
        "history_coverage",
        "projection_gap",
      ]),
    );
  });

  test("each signal carries the normalized contract shape", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    for (const signal of await signals(scopeId, "?limit=500")) {
      expect(signal.id).toMatch(/^wl_dqs_[a-f0-9]{32}$/);
      expect(signal.object).toBe("data_quality_signal");
      expect(["high", "medium", "low"]).toContain(signal.severity);
      expect(typeof signal.label).toBe("string");
      expect(signal.label.length).toBeGreaterThan(0);
      expect(typeof signal.code).toBe("string");
      expect(typeof signal.fixable).toBe("boolean");
    }
  });

  test("preserves both blocking and overrideable warnings without writing overrides", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-dq-warn-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_zero",
      liquidityTier: "illiquid",
      name: "Cuadro sin tasar",
      ownership: owner,
      type: "manual",
    });
    store.close();

    const scopeId = await householdScopeId();
    const before = await fingerprint(databasePath);
    const warningSignals = (await signals(scopeId, "?category=warning")).filter(
      (s) => s.category === "warning",
    );
    const after = await fingerprint(databasePath);

    expect(warningSignals).toHaveLength(1);
    const zero = warningSignals[0]!;
    expect(zero.code).toBe("ZERO_VALUE_ASSET");
    expect(zero.originalWarningType).toBe("ZERO_VALUE_ASSET");
    expect(zero.severity).toBe("medium");
    expect(zero.affected?.id).toMatch(/^wl_hld_/);
    // Reading the warning must not have persisted an override.
    expect(after).toBe(before);
    expect(JSON.parse(after).warningOverrides).toEqual([]);
  });

  test("represents stale and failed prices distinctly", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const priceSignals = (await signals(scopeId, "?category=price_freshness")).filter(
      (s) => s.category === "price_freshness",
    );

    const stale = priceSignals.find(
      (s) => s.code === "STALE_PRICE" && s.affected?.label === "Fondo viejo",
    )!;
    expect(stale.severity).toBe("medium");
    expect(stale.observedDate).toBe("2026-01-01");

    const failed = priceSignals.find((s) => s.code === "FAILED_PRICE")!;
    expect(failed.severity).toBe("high");
    expect(failed.affected?.label).toBe("Fondo roto");
    expect(failed.observedDate).toBe("2026-02-01");
  });

  test("represents a stale connected-source sync", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const sourceSignals = (await signals(scopeId, "?category=source_freshness")).filter(
      (s) => s.category === "source_freshness",
    );

    expect(sourceSignals).toHaveLength(1);
    expect(sourceSignals[0]!.code).toBe("STALE_SOURCE_SYNC");
    expect(sourceSignals[0]!.severity).toBe("medium");
    expect(sourceSignals[0]!.affected?.id).toMatch(/^wl_src_/);
    expect(sourceSignals[0]!.affected?.object).toBe("connected_source");
  });

  test("represents a missing FIRE config as a scope-global signal", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const configSignals = (
      await signals(scopeId, "?category=missing_configuration")
    ).filter((s) => s.category === "missing_configuration");

    const fire = configSignals.find((s) => s.code === "MISSING_FIRE_CONFIG")!;
    expect(fire.severity).toBe("medium");
    expect(fire.affected?.object).toBe("scope");
    expect(fire.affected?.id).toBe(scopeId);

    const debt = configSignals.find((s) => s.code === "MISSING_DEBT_MODEL")!;
    expect(debt.affected?.id).toMatch(/^wl_hld_/);
  });

  test("represents missing snapshot history", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const historySignals = (await signals(scopeId, "?category=history_coverage")).filter(
      (s) => s.category === "history_coverage",
    );

    expect(historySignals).toHaveLength(1);
    expect(historySignals[0]!.code).toBe("NO_SNAPSHOTS");
    expect(historySignals[0]!.affected?.object).toBe("scope");
  });

  test("represents an unvalued connected-source position as a projection gap", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const gapSignals = (await signals(scopeId, "?category=projection_gap")).filter(
      (s) => s.category === "projection_gap",
    );

    expect(gapSignals).toHaveLength(1);
    expect(gapSignals[0]!.code).toBe("UNVALUED_POSITION");
    expect(gapSignals[0]!.severity).toBe("medium");
    expect(gapSignals[0]!.label).toContain("sin fuente de precio");
    expect(gapSignals[0]!.affected?.id).toMatch(/^wl_src_/);
    expect(gapSignals[0]!.affected?.object).toBe("connected_source");
  });

  test("filters by severity", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const high = await signals(scopeId, "?severity=high&limit=500");
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((s) => s.severity === "high")).toBe(true);
  });

  test("orders by severity desc, then category, then affected id, then signal id", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const all = await signals(scopeId, "?limit=500");
    const severityRank = { high: 0, medium: 1, low: 2 } as const;
    const categoryRank: Record<string, number> = {
      warning: 0,
      price_freshness: 1,
      source_freshness: 2,
      missing_configuration: 3,
      history_coverage: 4,
      projection_gap: 5,
    };

    for (let i = 1; i < all.length; i += 1) {
      const a = all[i - 1]!;
      const b = all[i]!;
      const keyOf = (s: Signal) =>
        [
          severityRank[s.severity as keyof typeof severityRank],
          categoryRank[s.category],
          s.affected?.id ?? "",
          s.id,
        ] as const;
      expect(keyOf(a) <= keyOf(b)).toBe(true);
    }
  });

  test("paginates with stable cursors, walking every signal exactly once", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const all = await signals(scopeId, "?limit=500");
    const seen: string[] = [];

    const first = await dataQuality(scopeId, "?limit=1");
    seen.push(...(first.body.data as Signal[]).map((s) => s.id));
    expect(first.body.meta.hasNext).toBe(true);

    let cursor: string | undefined = first.body.meta.nextCursor;
    let guard = 0;
    while (cursor && guard++ < 100) {
      const page = await dataQuality(
        scopeId,
        `?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      seen.push(...(page.body.data as Signal[]).map((s) => s.id));
      cursor = page.body.meta.hasNext ? page.body.meta.nextCursor : undefined;
    }

    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
    expect(seen).toEqual(all.map((s) => s.id));
  });

  test("rejects an invalid category and severity with 400", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    expect((await dataQuality(scopeId, "?category=nope")).response.status).toBe(400);
    expect((await dataQuality(scopeId, "?severity=critical")).response.status).toBe(400);
    expect((await dataQuality(scopeId, "?nope=1")).response.status).toBe(400);
    expect((await dataQuality(scopeId, "?limit=0")).response.status).toBe(400);

    const clamped = await dataQuality(scopeId, "?limit=9999");
    expect(clamped.response.status).toBe(200);
    expect(clamped.body.meta.limit).toBe(500);
  });

  test("returns 404 for an unknown scope id", async () => {
    await seedAllCategories();
    const { body, response } = await dataQuality("wl_scp_doesnotexist");
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("requires the local capability token", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const response = await getDataQuality(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/data-quality`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(401);
  });

  test("reads do not mutate persisted state (no override writes)", async () => {
    const databasePath = await seedAllCategories("worthline-agent-view-dq-nomut-");
    const scopeId = await householdScopeId();

    const before = await fingerprint(databasePath);
    await dataQuality(scopeId, "?limit=500");
    await dataQuality(scopeId, "?category=warning");
    await dataQuality(scopeId, "?severity=high");
    await financialContext(scopeId);
    const after = await fingerprint(databasePath);

    expect(after).toBe(before);
  });

  test("MCP get_data_quality mirrors the HTTP shape and defaults to the household scope", async () => {
    await seedAllCategories();
    const household = await householdScopeId();
    const httpBody = (await dataQuality(household, "?limit=500")).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpDefault = await catalog.get_data_quality.invoke({ limit: 500 });
    const mcpExplicit = await catalog.get_data_quality.invoke({
      limit: 500,
      scopeId: household,
    });

    expect(mcpDefault).toEqual(httpBody);
    expect(mcpExplicit).toEqual(httpBody);

    const warningsOnly = await catalog.get_data_quality.invoke({
      category: "warning",
      limit: 500,
    });
    expect((warningsOnly.data as Signal[]).every((s) => s.category === "warning")).toBe(
      true,
    );
  });
});

describe("main financial context data-quality summary (#341)", () => {
  test("folds counts by severity and by category plus the top signals", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const { body } = await financialContext(scopeId);
    const summary = body.data.dataQuality;
    const allSignals = await signals(scopeId, "?limit=500");

    const totalBySeverity =
      summary.countsBySeverity.high +
      summary.countsBySeverity.medium +
      summary.countsBySeverity.low;
    expect(totalBySeverity).toBe(allSignals.length);

    const totalByCategory = Object.values(
      summary.countsByCategory as Record<string, number>,
    ).reduce((sum, count) => sum + count, 0);
    expect(totalByCategory).toBe(allSignals.length);

    // The summary reports every category key, even when zero.
    expect(Object.keys(summary.countsByCategory).sort()).toEqual(
      [
        "history_coverage",
        "missing_configuration",
        "price_freshness",
        "projection_gap",
        "source_freshness",
        "warning",
      ].sort(),
    );
  });

  test("caps the top signals at 10 in the stable order", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const { body } = await financialContext(scopeId);
    const top = body.data.dataQuality.topSignals as Signal[];
    const all = await signals(scopeId, "?limit=500");

    expect(top.length).toBeLessThanOrEqual(10);
    expect(top.map((s) => s.id)).toEqual(all.slice(0, top.length).map((s) => s.id));
  });
});
