import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getDataQuality } from "@web/api/v1/agent-view/scopes/[scopeId]/data-quality/route";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";
import { DATA_QUALITY_CATEGORY_ORDER } from "@worthline/domain";
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
  const store = await createWorthlineStoreUnsafe({ databasePath });
  const sources = await store.connectedSources.listSources();
  const snapshot = JSON.stringify({
    assets: await store.assets.readAssets(),
    fireConfig: await store.readFireConfig("2026-08-18"),
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

async function backdateAssetCreatedAt(
  databasePath: string,
  assetId: string,
  iso: string,
): Promise<void> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${databasePath}` });
  await client.execute({
    args: [iso, assetId],
    sql: "UPDATE assets SET created_at = ? WHERE id = ?",
  });
  client.close();
}

/**
 * Record terminal sync attempts for a source, newest LAST in the given order
 * (#1226). Written straight to `sync_run` on purpose: the public store exposes only
 * the READ half of the run store — a run is opened and finalized exclusively by
 * whoever executes the sync — so a test that needs a history of outcomes seeds the
 * rows the same way it backdates an asset's `created_at`.
 */
async function recordSyncRuns(
  databasePath: string,
  sourceId: string,
  runs: readonly { status: "ok" | "error"; at: string }[],
): Promise<void> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${databasePath}` });
  for (const run of runs) {
    await client.execute({
      args: [
        // Fechado, no numerado: el helper se llama más de una vez sobre la misma
        // base para alargar el historial, y un contador reiniciado colisionaría.
        `sync_run_seed_${run.at}`,
        sourceId,
        run.status,
        run.status === "error"
          ? JSON.stringify({
              code: "sync_persist_failed",
              message: "libsql: SQLITE_BUSY",
              retriable: true,
            })
          : null,
        run.at,
        run.at,
        run.at,
      ],
      sql:
        "INSERT INTO sync_run (id, source_id, trigger, status, error_json, started_at, finished_at, created_at) " +
        "VALUES (?, ?, 'cron', ?, ?, ?, ?, ?)",
    });
  }
  client.close();
}

/**
 * Seed a household that triggers every category at least once:
 *  - warning: a zero-value stored asset (ZERO_VALUE_ASSET, overrideable).
 *  - manual_value_freshness: a stored cash holding with no value update in 90+ days.
 *  - price_freshness: a stale-priced and a failed-priced asset.
 *  - source_freshness: a connected source with a stale last sync.
 *  - missing_configuration: no FIRE config + a mortgage with no debt model.
 *  - history_coverage: no snapshots for the scope.
 *  - projection_gap: an unpriced Binance token (null unitPrice).
 *  - trashed_balance: an investment sent to the Papelera with units still held.
 */
async function seedAllCategories(prefix = "worthline-agent-view-dq-"): Promise<string> {
  const databasePath = tempDatabasePath(prefix);
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStoreUnsafe({ databasePath });
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

  // manual_value_freshness: a cash account created long ago, never value-updated.
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 2_500_00,
    id: "asset_stale_cash",
    liquidityTier: "market",
    name: "Cuenta olvidada",
    ownership: owner,
    type: "cash",
  });
  await backdateAssetCreatedAt(
    databasePath,
    "asset_stale_cash",
    "2025-01-01T00:00:00.000Z",
  );

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

  // trashed_balance: an investment with a bought-and-never-sold ledger, sent to
  // the Papelera. Its value left the patrimonio at the next capture with no sale
  // recorded anywhere (#1365) — and, being trashed, it is invisible to every live
  // read the rest of this seed exercises.
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_trashed_fund",
    liquidityTier: "market",
    name: "Fondo borrado con saldo",
    ownership: owner,
  });
  // Archived before its ledger exists — the only way to reach this state since the
  // Papelera's door (#1549), and the shape of the rows archived before it existed.
  await store.assets.softDeleteAsset("asset_trashed_fund", "2026-07-01T10:00:00.000Z");
  await store.operations.recordOperation({
    assetId: "asset_trashed_fund",
    currency: "EUR",
    executedAt: "2026-01-10",
    feesMinor: 0,
    id: "op_trashed_buy",
    kind: "buy",
    pricePerUnit: "100",
    units: "10",
  });

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
        "trashed_balance",
        "manual_value_freshness",
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

    const store = await createWorthlineStoreUnsafe({ databasePath });
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

  /**
   * S4 del PRD #1222 (#1226) sobre el contrato real: la señal de sync que falla de
   * forma sostenida se expone también por las superficies agent/MCP, y su umbral se
   * mide sobre las filas de `sync_run` que la base tiene de verdad — no sobre un
   * mapa cocinado en un test de unidad.
   */
  test("represents a connection whose sync keeps failing, and clears on a good one", async () => {
    const databasePath = await seedAllCategories("worthline-agent-view-dq-sync-");
    const store = await createWorthlineStoreUnsafe({ databasePath });
    const [source] = await store.connectedSources.listSources();
    store.close();

    await recordSyncRuns(databasePath, source!.id, [
      { at: "2026-06-18T09:00:00.000Z", status: "error" },
      { at: "2026-06-19T09:00:00.000Z", status: "error" },
    ]);

    const scopeId = await householdScopeId();
    const failing = (await signals(scopeId, "?limit=500")).find(
      (s) => s.code === "PERSISTENT_SYNC_FAILURE",
    )!;

    expect(failing.category).toBe("source_freshness");
    expect(failing.severity).toBe("high");
    expect(failing.fixable).toBe(false);
    expect(failing.affected?.id).toMatch(/^wl_src_/);
    expect(failing.affected?.object).toBe("connected_source");
    expect(failing.observedDate).toBe("2026-06-19");
    expect(failing.label).toContain("Las últimas 2 sincronizaciones");
    // El `message` crudo de la fila (texto de driver) nunca cruza el contrato.
    expect(failing.label).not.toContain("SQLITE_BUSY");

    // Un sync bueno posterior cierra la racha: la señal desaparece.
    await recordSyncRuns(databasePath, source!.id, [
      { at: "2026-06-20T09:00:00.000Z", status: "ok" },
    ]);

    expect(
      (await signals(scopeId, "?limit=500")).filter(
        (s) => s.code === "PERSISTENT_SYNC_FAILURE",
      ),
    ).toEqual([]);
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

  test("represents a stale manual value for a stored holding", async () => {
    await seedAllCategories();
    const scopeId = await householdScopeId();

    const manualSignals = (
      await signals(scopeId, "?category=manual_value_freshness")
    ).filter((s) => s.category === "manual_value_freshness");

    const stale = manualSignals.find((s) => s.affected?.label === "Cuenta olvidada")!;
    expect(stale.code).toBe("STALE_MANUAL_VALUE");
    expect(stale.severity).toBe("medium");
    expect(stale.fixable).toBe(true);
    expect(stale.observedDate).toBe("2025-01-01");
    expect(stale.affected?.id).toMatch(/^wl_hld_/);
  });

  test("labels an acknowledged stale-manual signal without removing it", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-dq-stale-override-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 2_500_00,
      id: "asset_stale_cash",
      liquidityTier: "market",
      name: "Cuenta olvidada",
      ownership: owner,
      type: "cash",
    });
    await backdateAssetCreatedAt(
      databasePath,
      "asset_stale_cash",
      "2025-01-01T00:00:00.000Z",
    );
    await store.acknowledgeWarning("STALE_MANUAL_VALUE", "asset_stale_cash");
    store.close();

    const scopeId = await householdScopeId();
    const staleSignals = (
      await signals(scopeId, "?category=manual_value_freshness")
    ).filter((s) => s.code === "STALE_MANUAL_VALUE");

    expect(staleSignals).toHaveLength(1);
    expect(staleSignals[0]!.label).toContain("marcado como intencional");
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
    // Read off the engine's own order: a hand-kept mirror silently stops covering
    // a newly inserted category (its rank comes back `undefined`).
    const categoryRank: Record<string, number> = Object.fromEntries(
      DATA_QUALITY_CATEGORY_ORDER.map((category, rank) => [category, rank]),
    );

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

describe("MISSING_PROVIDER_SYMBOL on closed positions (#1348)", () => {
  /**
   * A symbol-less fund with a ledger: bought whole, then optionally sold whole.
   * `soldOut` is the only thing that varies, so the assertions below isolate the
   * closed-position filter from every other reason a warning could appear.
   */
  async function seedSymbollessFund(soldOut: boolean): Promise<void> {
    const databasePath = tempDatabasePath("worthline-agent-view-dq-closed-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo sin símbolo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    await store.operations.recordOperation({
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_buy",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });
    if (soldOut) {
      await store.operations.recordOperation({
        assetId: "asset_fund",
        currency: "EUR",
        executedAt: "2026-06-10",
        feesMinor: 0,
        id: "op_sell_all",
        kind: "sell",
        pricePerUnit: "120",
        units: "10",
      });
    }
    store.close();
  }

  async function symbolSignals(): Promise<Signal[]> {
    const scopeId = await householdScopeId();
    return (await signals(scopeId, "?limit=500")).filter(
      (signal) => signal.code === "MISSING_PROVIDER_SYMBOL",
    );
  }

  /**
   * The symbol'd sibling: this fund never raised MISSING_PROVIDER_SYMBOL, but its
   * cached price keeps failing after the position is sold out — and FAILED_PRICE
   * is `high`, so it reddens the hero over a holding worth 0.
   */
  async function seedSymbolledFundWithFailedPrice(soldOut: boolean): Promise<void> {
    const databasePath = tempDatabasePath("worthline-agent-view-dq-closed-price-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_etf",
      liquidityTier: "market",
      name: "ETF con símbolo",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      providerSymbol: "SOLD.MI",
    });
    await store.operations.recordOperation({
      assetId: "asset_etf",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_buy",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });
    if (soldOut) {
      await store.operations.recordOperation({
        assetId: "asset_etf",
        currency: "EUR",
        executedAt: "2026-06-10",
        feesMinor: 0,
        id: "op_sell_all",
        kind: "sell",
        pricePerUnit: "120",
        units: "10",
      });
    }
    await store.operations.upsertPrice({
      assetId: "asset_etf",
      currency: "EUR",
      fetchedAt: "2026-02-01T00:00:00.000Z",
      freshnessState: "failed",
      price: "100",
      source: "yahoo",
      staleReason: "Proveedor caído",
    });
    store.close();
  }

  async function priceSignals(): Promise<Signal[]> {
    const scopeId = await householdScopeId();
    return (await signals(scopeId, "?limit=500")).filter(
      (signal) => signal.category === "price_freshness",
    );
  }

  test("a fund sold in full stops reporting a missing price symbol", async () => {
    await seedSymbollessFund(true);
    expect(await symbolSignals()).toEqual([]);
  });

  test("the same fund still open reports it, so the filter is not blanket silence", async () => {
    await seedSymbollessFund(false);
    const found = await symbolSignals();

    expect(found).toHaveLength(1);
    expect(found[0]!.affected?.label).toBe("Fondo sin símbolo");
  });

  test("reopening a closed position with a new buy brings the signal back", async () => {
    await seedSymbollessFund(true);
    expect(await symbolSignals()).toEqual([]);

    const store = await createWorthlineStoreUnsafe({
      databasePath: process.env.WORTHLINE_DB_PATH!,
    });
    await store.operations.recordOperation({
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-07-01",
      feesMinor: 0,
      id: "op_rebuy",
      kind: "buy",
      pricePerUnit: "130",
      units: "4",
    });
    store.close();

    expect(await symbolSignals()).toHaveLength(1);
  });

  test("a sold-out position stops reporting its failed price too", async () => {
    await seedSymbolledFundWithFailedPrice(true);
    expect(await priceSignals()).toEqual([]);
  });

  test("the same position still open reports the failed price", async () => {
    await seedSymbolledFundWithFailedPrice(false);
    const found = await priceSignals();

    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe("FAILED_PRICE");
    expect(found[0]!.severity).toBe("high");
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
        "manual_value_freshness",
        "missing_configuration",
        "portfolio_reconciliation",
        "price_freshness",
        "projection_gap",
        "savings_coherence",
        "source_freshness",
        "trashed_balance",
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

/**
 * Sending a holding to the Papelera with units still inside takes its value out of
 * the patrimonio and records nowhere that it went (#1365). The signal has to reach
 * the agent view through plumbing NO live read touches: the trash is excluded from
 * `readAssets`, so both the holding and its ledger are fetched by id.
 */
describe("TRASHED_WITH_BALANCE (#1365)", () => {
  /** A fund bought whole, optionally sold whole, then sent to the Papelera. */
  async function seedTrashedFund(options: {
    soldOut: boolean;
    trashed: boolean;
  }): Promise<void> {
    const databasePath = tempDatabasePath("worthline-agent-view-dq-trashed-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo Indexado",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    // Archived BEFORE its ledger exists, which is how a row reaches this state at
    // all now: since #1549 the Papelera's door refuses to archive a holding with
    // units unless the owner declares «fue un error de registro», and that
    // declaration silences this very signal. What the signal still hunts is the
    // rows archived before the door existed — the ones in Jorge's real book.
    if (options.trashed) {
      await store.assets.softDeleteAsset("asset_fund", "2026-07-01T10:00:00.000Z");
    }
    await store.operations.recordOperation({
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_buy",
      kind: "buy",
      pricePerUnit: "100",
      units: "10",
    });
    if (options.soldOut) {
      await store.operations.recordOperation({
        assetId: "asset_fund",
        currency: "EUR",
        executedAt: "2026-06-10",
        feesMinor: 0,
        id: "op_sell_all",
        kind: "sell",
        pricePerUnit: "120",
        units: "10",
      });
    }
    store.close();
  }

  async function trashedSignals(): Promise<Signal[]> {
    const scopeId = await householdScopeId();
    return (await signals(scopeId, "?limit=500")).filter(
      (signal) => signal.code === "TRASHED_WITH_BALANCE",
    );
  }

  test("a holding trashed with units raises the signal, named by its public id", async () => {
    await seedTrashedFund({ soldOut: false, trashed: true });
    const found = await trashedSignals();

    expect(found).toHaveLength(1);
    expect(found[0]!.category).toBe("trashed_balance");
    expect(found[0]!.severity).toBe("high");
    expect(found[0]!.label).toContain("Fondo Indexado");
    expect(found[0]!.label).toContain("10 unidades");
    // The affected reference speaks the public `wl_hld_…` vocabulary, so the
    // assistant can act on it — the trash keeps its id across the soft delete.
    expect(found[0]!.affected?.object).toBe("holding");
    expect(found[0]!.affected?.id).toMatch(/^wl_hld_/);
  });

  test("selling out before deleting is the correct exit, and it is silent", async () => {
    await seedTrashedFund({ soldOut: true, trashed: true });

    expect(await trashedSignals()).toEqual([]);
  });

  test("a live holding with units is not in the trash and raises nothing", async () => {
    await seedTrashedFund({ soldOut: false, trashed: false });

    expect(await trashedSignals()).toEqual([]);
  });

  test("filtering by the new category returns it and nothing else", async () => {
    await seedTrashedFund({ soldOut: false, trashed: true });
    const scopeId = await householdScopeId();

    const page = await signals(scopeId, "?category=trashed_balance");

    expect(page).toHaveLength(1);
    expect(page[0]!.code).toBe("TRASHED_WITH_BALANCE");
  });
});

// ---------------------------------------------------------------------------
// SAVINGS_DECLARED_VS_MEASURED (#1449)
// ---------------------------------------------------------------------------

describe("data-quality — declared vs measured savings (#1449)", () => {
  /**
   * The 12 calendar months ending this month, as `YYYY-MM`. Relative to the real
   * clock on purpose: the endpoint reads `systemClock()`, so a seed with hard-coded
   * 2026 dates would fall out of the measurement window as time passes and turn
   * this guard green for the wrong reason.
   */
  function trailingMonths(): string[] {
    const now = new Date();
    return Array.from({ length: 12 }, (_, index) => {
      const month = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - index), 1),
      );
      return month.toISOString().slice(0, 7);
    });
  }

  /** Declares 1.500 €/month of savings against a ledger that buys `monthlyMajor` €. */
  async function seedDeclaredVsMeasured(monthlyMajor: number): Promise<void> {
    const databasePath = tempDatabasePath("worthline-agent-view-dq-savings-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo Indexado",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });

    for (const month of trailingMonths()) {
      await store.operations.recordOperation({
        assetId: "asset_fund",
        currency: "EUR",
        executedAt: `${month}-10`,
        feesMinor: 0,
        id: `op_buy_${month}`,
        kind: "buy",
        pricePerUnit: "1",
        units: String(monthlyMajor),
      });
    }

    await store.saveFireConfig("household", {
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.04,
      monthlySavingsCapacityMinor: 150_000,
    });
    store.close();
  }

  async function savingsSignals(): Promise<Signal[]> {
    const scopeId = await householdScopeId();
    return signals(scopeId, "?limit=500&category=savings_coherence");
  }

  // The engine can only judge what the endpoint hands it: this is the guard on the
  // agent view actually reading the operations ledger, not just the net units.
  test("surfaces the gap when the ledger cannot back the declared capacity", async () => {
    await seedDeclaredVsMeasured(120);

    const found = await savingsSignals();

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      category: "savings_coherence",
      code: "SAVINGS_DECLARED_VS_MEASURED",
      fixable: true,
      severity: "medium",
    });
    expect(found[0]!.label).toContain("Declaras ahorrar");
  });

  test("stays quiet when the ledger backs it", async () => {
    await seedDeclaredVsMeasured(1500);

    expect(await savingsSignals()).toEqual([]);
  });
});

describe("data-quality — el saldo declarado de una cartera gestionada (#1550)", () => {
  /**
   * The real Metal of the acceptance criteria: seven funds worth 1.479,26 €
   * (folded here into one member with the same value) and the container's cash
   * sibling, against the 1.497,37 € read in MyInvestor on 21-08 → −1,21 %.
   */
  const FUNDS_MINOR = 147_926;
  const DECLARED_MINOR = 149_737;

  /** Seeds the Metal and declares `declaredMinor`, with `cashMinor` in its box. */
  async function seedMetal(input: {
    declaredMinor: number | null;
    cashMinor: number;
  }): Promise<{ portfolioPublicId: string }> {
    const databasePath = tempDatabasePath("worthline-agent-view-dq-cartera-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fondos",
      liquidityTier: "market",
      name: "Fondos de la Metal",
      ownership: owner,
      providerSymbol: "IWDA.AS",
    });
    await store.operations.recordOperation({
      assetId: "asset_fondos",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_buy_metal",
      kind: "buy",
      pricePerUnit: "1",
      units: "100",
    });
    // 100 × 14,7926 = 1.479,26 € — the derived value of the funds today.
    await store.operations.upsertPrice({
      assetId: "asset_fondos",
      currency: "EUR",
      fetchedAt: new Date().toISOString(),
      freshnessState: "fresh",
      price: "14.7926",
      source: "yahoo",
    });

    const portfolio = await store.managedPortfolios.createManagedPortfolio({
      cashOwnership: owner,
      memberHoldingIds: ["asset_fondos"],
      name: "Cartera Indexada Metal",
      provider: "MyInvestor",
      scopeId: "household",
    });
    const cashId = portfolio.holdingIds.find((id) => id !== "asset_fondos")!;
    await store.assets.updateAssetValuation(cashId, input.cashMinor);

    if (input.declaredMinor !== null) {
      await store.managedPortfolios.declareManagedPortfolioBalance(portfolio.id, {
        declaredDate: "2026-08-21",
        declaredValue: { amountMinor: input.declaredMinor, currency: "EUR" },
      });
    }

    const publicIds = await store.agentView.readPublicIds();
    const portfolioPublicId = publicIds.find(
      (row) => row.entityType === "managed_portfolio" && row.entityId === portfolio.id,
    )!.publicId;
    store.close();
    return { portfolioPublicId };
  }

  async function witnessSignals(): Promise<Signal[]> {
    const scopeId = await householdScopeId();
    return signals(scopeId, "?limit=500&category=portfolio_reconciliation");
  }

  test("stays quiet at the real drift of the Metal (−1,21 %)", async () => {
    await seedMetal({ cashMinor: 734, declaredMinor: DECLARED_MINOR });

    expect(await witnessSignals()).toEqual([]);
  });

  test("stays quiet with the cash box FULL (~157 €): the careo excludes it", async () => {
    // 150 € + 0,5 % × 1.497,37 = 157,49 € waiting to be invested. Careing the
    // cash would fire a ~9 % drift before every single contribution — the
    // regression of the 23-08 correction on #1550.
    await seedMetal({ cashMinor: 15_749, declaredMinor: DECLARED_MINOR });

    expect(await witnessSignals()).toEqual([]);
  });

  test("names the cartera by its public id when the drift passes 2 %", async () => {
    const { portfolioPublicId } = await seedMetal({
      cashMinor: 734,
      declaredMinor: Math.round(FUNDS_MINOR / 0.95),
    });

    const found = await witnessSignals();

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      affected: {
        id: portfolioPublicId,
        label: "Cartera Indexada Metal",
        object: "managed_portfolio",
      },
      category: "portfolio_reconciliation",
      code: "PORTFOLIO_DECLARED_VS_DERIVED",
      fixable: true,
      observedDate: "2026-08-21",
      severity: "medium",
    });
    expect(portfolioPublicId.startsWith("wl_prt_")).toBe(true);
  });

  test("declares nothing to careo without a witness", async () => {
    await seedMetal({ cashMinor: 15_749, declaredMinor: null });

    expect(await witnessSignals()).toEqual([]);
  });

  test("se apaga sola al actualizar el testigo, sin reconocer nada", async () => {
    await seedMetal({ cashMinor: 734, declaredMinor: Math.round(FUNDS_MINOR / 0.95) });
    expect(await witnessSignals()).toHaveLength(1);

    // Declaring the right balance is the whole repair: the signal is derived, so
    // there is no override to write and nothing to acknowledge.
    const store = await createWorthlineStoreUnsafe({
      databasePath: process.env.WORTHLINE_DB_PATH!,
    });
    const [portfolio] = await store.managedPortfolios.readManagedPortfolios("household");
    await store.managedPortfolios.declareManagedPortfolioBalance(portfolio!.id, {
      declaredDate: "2026-08-23",
      declaredValue: { amountMinor: DECLARED_MINOR, currency: "EUR" },
    });
    store.close();

    expect(await witnessSignals()).toEqual([]);
  });

  test("se apaga sola al cambiar la composición de la cartera", async () => {
    await seedMetal({ cashMinor: 734, declaredMinor: Math.round(FUNDS_MINOR / 0.95) });
    expect(await witnessSignals()).toHaveLength(1);

    // The other repair the issue names: the composition changes (here the fund
    // leaves the cartera), so there is no investment value to careo any more.
    const store = await createWorthlineStoreUnsafe({
      databasePath: process.env.WORTHLINE_DB_PATH!,
    });
    const [portfolio] = await store.managedPortfolios.readManagedPortfolios("household");
    await store.managedPortfolios.updateManagedPortfolio(portfolio!.id, {
      memberHoldingIds: [],
    });
    store.close();

    expect(await witnessSignals()).toEqual([]);
  });

  test("the financial context carries the careo, cash apart", async () => {
    await seedMetal({ cashMinor: 15_749, declaredMinor: DECLARED_MINOR });
    const scopeId = await householdScopeId();

    const { body } = await financialContext(scopeId);
    const cartera = body.data.managedPortfolios[0];

    expect(cartera.label).toBe("Cartera Indexada Metal");
    expect(cartera.reconciliation).toMatchObject({
      cashValue: { amountMinor: 15_749, currency: "EUR" },
      declaredDate: "2026-08-21",
      declaredValue: { amountMinor: DECLARED_MINOR, currency: "EUR" },
      driftBps: -121,
      investmentValue: { amountMinor: FUNDS_MINOR, currency: "EUR" },
      state: "aligned",
      thresholdBps: 200,
    });
  });
});
