import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";

import { createWorthlineStore } from "@worthline/db";
import { GET as getScopes } from "../apps/web/app/api/v1/agent-view/scopes/route";
import { GET as getFinancialContext } from "../apps/web/app/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getTrashSummary } from "../apps/web/app/api/v1/agent-view/scopes/[scopeId]/trash-summary/route";
import { createAgentViewMcpToolCatalog } from "../apps/web/app/agent-view/mcp";
import type { AgentViewApiClient } from "../apps/web/app/agent-view/mcp";
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

interface TrashHolding {
  id: string;
  object: string;
  label: string;
  direction: string;
  instrument: string;
  value?: { amountMinor: number; currency: string };
  deletedDate?: string;
  status: { restorable: boolean; hardDeletable: boolean };
}

async function trashSummary(scopeId: string, query = "") {
  const response = await getTrashSummary(
    authedRequest(`/api/v1/agent-view/scopes/${scopeId}/trash-summary${query}`),
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

async function holdings(scopeId: string, query = ""): Promise<TrashHolding[]> {
  return (await trashSummary(scopeId, query)).body.data as TrashHolding[];
}

// A fingerprint of every mutation-prone read to prove a trash-summary read writes
// nothing — no restore, no hard-delete, no audit row, no public-id creation.
function fingerprint(databasePath: string): string {
  const store = createWorthlineStore({ databasePath });
  const sources = store.connectedSources.listSources();
  const snapshot = JSON.stringify({
    assets: store.assets.readAssets(),
    auditLog: store.readAuditLog(),
    fireConfig: store.readFireConfig(),
    liabilities: store.liabilities.readLiabilities(),
    positions: sources.map((source) => ({
      positions: store.connectedSources.readPositions(source.id),
      sourceId: source.id,
    })),
    priceCache: store.operations.readAllPriceCacheEntries(),
    publicIds: store.agentView.readPublicIds(),
    snapshots: store.snapshots.readSnapshots("household"),
    sources,
    trash: store.readTrash(),
    warningOverrides: store.readWarningOverrides(),
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

    const trashMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/trash-summary$/,
    );
    if (trashMatch) {
      const scopeId = decodeURIComponent(trashMatch[1]!);
      const response = await getTrashSummary(req, {
        params: Promise.resolve({ scopeId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

/**
 * Seed a household with several live holdings plus several trashed holdings
 * (assets AND a liability) soft-deleted at different dates, so the suite can
 * assert trash is ABSENT from the main context but PRESENT in the trash summary,
 * with a stable deletedDate-desc / id-desc order and cursor pagination.
 */
function seedTrash(prefix = "worthline-agent-view-trash-"): string {
  const databasePath = tempDatabasePath(prefix);
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = createWorthlineStore({ databasePath });
  store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

  // Live holdings that must stay in the main context.
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 10_000_00,
    id: "asset_live",
    instrument: "fund",
    liquidityTier: "market",
    name: "Fondo vivo",
    ownership: owner,
    type: "manual",
  });
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 5_000_00,
    id: "asset_live_cash",
    instrument: "current_account",
    liquidityTier: "cash",
    name: "Cuenta viva",
    ownership: owner,
    type: "cash",
  });

  // Trashed assets, soft-deleted at different dates.
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 2_000_00,
    id: "asset_trash_old",
    instrument: "fund",
    liquidityTier: "market",
    name: "Fondo borrado antiguo",
    ownership: owner,
    type: "investment",
  });
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 3_500_00,
    id: "asset_trash_new",
    instrument: "stock",
    liquidityTier: "market",
    name: "Acciones borradas",
    ownership: owner,
    type: "investment",
  });

  // A trashed liability.
  store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 150_000_00,
    id: "asset_home",
    instrument: "property",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: owner,
    type: "real_estate",
  });
  store.liabilities.createLiability({
    associatedAssetId: "asset_home",
    balanceMinor: 40_000_00,
    currency: "EUR",
    id: "liab_trash",
    name: "Préstamo borrado",
    ownership: owner,
    type: "debt",
  });

  // Soft-delete the three trashed holdings at distinct dates so the
  // deletedDate-desc ordering is deterministic.
  store.assets.softDeleteAsset("asset_trash_old", "2026-01-10T08:00:00.000Z");
  store.liabilities.softDeleteLiability("liab_trash", "2026-03-15T08:00:00.000Z");
  store.assets.softDeleteAsset("asset_trash_new", "2026-05-20T08:00:00.000Z");

  store.close();
  return databasePath;
}

describe("GET /api/v1/agent-view/scopes/{scopeId}/trash-summary", () => {
  test("excludes trashed holdings from the main financial context", async () => {
    seedTrash();
    const scopeId = await householdScopeId();

    const { body } = await financialContext(scopeId, "?holdingLimit=100");
    const context = body.data;
    const labels = (context.holdings.items as { label: string }[]).map((h) => h.label);

    // The two live holdings are present.
    expect(labels).toContain("Fondo vivo");
    expect(labels).toContain("Cuenta viva");

    // No trashed holding leaks into holdings, exposure top holdings, or omitted.
    const trashedLabels = [
      "Fondo borrado antiguo",
      "Acciones borradas",
      "Préstamo borrado",
    ];
    for (const trashed of trashedLabels) {
      expect(labels).not.toContain(trashed);
    }
    const exposureLabels = (context.exposure.topHoldings as { label: string }[]).map(
      (h) => h.label,
    );
    for (const trashed of trashedLabels) {
      expect(exposureLabels).not.toContain(trashed);
    }
    expect(context.holdings.omittedCount).toBe(0);

    // Gross assets reflect only the live assets (10000 + 5000 + 150000 home).
    expect(context.summary.grossAssets.amountMinor).toBe(165_000_00);
    // Debts reflect no liabilities (the only one is trashed).
    expect(context.summary.debts.amountMinor).toBe(0);
  });

  test("returns the trashed holdings with the full contract shape", async () => {
    seedTrash();
    const scopeId = await householdScopeId();

    const all = await holdings(scopeId, "?limit=500");
    expect(all).toHaveLength(3);

    const byLabel = new Map(all.map((h) => [h.label, h]));

    const asset = byLabel.get("Acciones borradas")!;
    expect(asset.id).toMatch(/^wl_hld_/);
    expect(asset.object).toBe("holding");
    expect(asset.direction).toBe("asset");
    expect(asset.instrument).toBe("stock");
    expect(asset.value).toEqual({ amountMinor: 3_500_00, currency: "EUR" });
    expect(asset.deletedDate).toBe("2026-05-20");
    expect(asset.status).toEqual({ hardDeletable: true, restorable: true });

    const liability = byLabel.get("Préstamo borrado")!;
    expect(liability.id).toMatch(/^wl_hld_/);
    expect(liability.direction).toBe("liability");
    expect(liability.value).toEqual({ amountMinor: 40_000_00, currency: "EUR" });
    expect(liability.deletedDate).toBe("2026-03-15");
  });

  test("orders by deleted date desc, then public holding id desc", async () => {
    seedTrash();
    const scopeId = await householdScopeId();

    const all = await holdings(scopeId, "?limit=500");
    // Newest deletion first: 2026-05-20, 2026-03-15, 2026-01-10.
    expect(all.map((h) => h.label)).toEqual([
      "Acciones borradas",
      "Préstamo borrado",
      "Fondo borrado antiguo",
    ]);

    for (let i = 1; i < all.length; i += 1) {
      const a = all[i - 1]!;
      const b = all[i]!;
      const dateA = a.deletedDate ?? "";
      const dateB = b.deletedDate ?? "";
      if (dateA === dateB) {
        expect(a.id >= b.id).toBe(true);
      } else {
        expect(dateA > dateB).toBe(true);
      }
    }
  });

  test("paginates with stable cursors, walking every trashed holding exactly once", async () => {
    seedTrash();
    const scopeId = await householdScopeId();

    const all = await holdings(scopeId, "?limit=500");
    const seen: string[] = [];

    const first = await trashSummary(scopeId, "?limit=1");
    seen.push(...(first.body.data as TrashHolding[]).map((h) => h.id));
    expect(first.body.meta.hasNext).toBe(true);

    let cursor: string | undefined = first.body.meta.nextCursor;
    let guard = 0;
    while (cursor && guard++ < 100) {
      const page = await trashSummary(
        scopeId,
        `?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      seen.push(...(page.body.data as TrashHolding[]).map((h) => h.id));
      cursor = page.body.meta.hasNext ? page.body.meta.nextCursor : undefined;
    }

    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
    expect(seen).toEqual(all.map((h) => h.id));
  });

  test("rejects an unknown param / bad limit with 400 and clamps over-max", async () => {
    seedTrash();
    const scopeId = await householdScopeId();

    expect((await trashSummary(scopeId, "?nope=1")).response.status).toBe(400);
    expect((await trashSummary(scopeId, "?limit=0")).response.status).toBe(400);
    expect((await trashSummary(scopeId, "?limit=abc")).response.status).toBe(400);
    expect((await trashSummary(scopeId, "?cursor=not-base64!!")).response.status).toBe(
      400,
    );

    const clamped = await trashSummary(scopeId, "?limit=9999");
    expect(clamped.response.status).toBe(200);
    expect(clamped.body.meta.limit).toBe(500);
  });

  test("returns 404 for an unknown scope id", async () => {
    seedTrash();
    const { body, response } = await trashSummary("wl_scp_doesnotexist");
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("requires the local capability token", async () => {
    seedTrash();
    const scopeId = await householdScopeId();

    const response = await getTrashSummary(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/trash-summary`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(401);
  });

  test("reads do not mutate persisted state (no restore / hard-delete / audit)", async () => {
    const databasePath = seedTrash("worthline-agent-view-trash-nomut-");
    const scopeId = await householdScopeId();

    const before = fingerprint(databasePath);
    await trashSummary(scopeId, "?limit=500");
    await trashSummary(scopeId, "?limit=1");
    await financialContext(scopeId);
    const after = fingerprint(databasePath);

    expect(after).toBe(before);
  });

  test("MCP get_trash_summary mirrors the HTTP shape and defaults to the household scope", async () => {
    seedTrash();
    const household = await householdScopeId();
    const httpBody = (await trashSummary(household, "?limit=500")).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpDefault = await catalog.get_trash_summary.invoke({ limit: 500 });
    const mcpExplicit = await catalog.get_trash_summary.invoke({
      limit: 500,
      scopeId: household,
    });

    expect(mcpDefault).toEqual(httpBody);
    expect(mcpExplicit).toEqual(httpBody);
  });
});
