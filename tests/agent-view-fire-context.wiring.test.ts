import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getFireContext } from "@web/api/v1/agent-view/scopes/[scopeId]/fire-context/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStore } from "@worthline/db";
import type { FireScopeConfig } from "@worthline/domain";
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

function scopesRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1/api/v1/agent-view/scopes", {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

function fireContextRequest(scopeId: string, query = ""): NextRequest {
  return new NextRequest(
    `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/fire-context${query}`,
    {
      headers: { authorization: "Bearer local-agent-token" },
      method: "GET",
    },
  );
}

function financialContextRequest(scopeId: string, query = ""): NextRequest {
  return new NextRequest(
    `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/financial-context${query}`,
    {
      headers: { authorization: "Bearer local-agent-token" },
      method: "GET",
    },
  );
}

interface ScopeRef {
  id: string;
  type: string;
  label: string;
}

async function listScopes(): Promise<ScopeRef[]> {
  const body = await (await getScopes(scopesRequest())).json();
  return body.data as ScopeRef[];
}

async function householdScopeId(): Promise<string> {
  const scopes = await listScopes();
  return scopes.find((scope) => scope.type === "household")!.id;
}

async function fireContext(scopeId: string, query = "") {
  const response = await getFireContext(fireContextRequest(scopeId, query), {
    params: Promise.resolve({ scopeId }),
  });
  return { body: await response.json(), response };
}

async function financialContext(scopeId: string, query = "") {
  const response = await getFinancialContext(financialContextRequest(scopeId, query), {
    params: Promise.resolve({ scopeId }),
  });
  return { body: await response.json(), response };
}

function eur(amountMinor: number) {
  return { amountMinor, currency: "EUR" };
}

// A fingerprint of every mutation-prone read, including the FIRE config, to
// prove a FIRE read writes nothing.
async function fingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStore({ databasePath });
  const snapshot = JSON.stringify({
    assets: await store.assets.readAssets(),
    fireConfig: await store.readFireConfig(),
    liabilities: await store.liabilities.readLiabilities(),
    priceCache: await store.operations.readAllPriceCacheEntries(),
    publicIds: await store.agentView.readPublicIds(),
    snapshots: await store.snapshots.readSnapshots("household"),
  });
  store.close();
  return snapshot;
}

// An API client that dispatches MCP calls to the real route handlers, so MCP
// output is proven against the HTTP contract rather than a hand-written double.
const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = new NextRequest(url, {
      headers: { authorization: "Bearer local-agent-token" },
      method: "GET",
    });

    if (url.pathname === "/api/v1/agent-view/scopes") {
      return (await (await getScopes(req)).json()) as T;
    }

    const fireMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/fire-context$/,
    );
    if (fireMatch) {
      const scopeId = decodeURIComponent(fireMatch[1]);
      const response = await getFireContext(req, {
        params: Promise.resolve({ scopeId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

const CONFIGURED: FireScopeConfig = {
  expectedRealReturn: 0.05,
  monthlySpendingMinor: 2_000_00,
  safeWithdrawalRate: 0.04,
};

// fireNumber = 2_000_00 * 12 / 0.04 = 600_000_00.
const FIRE_NUMBER = 600_000_00;

// Seed a household with: a primary residence (excluded), a manually-excluded
// asset, and two eligible assets. The household FIRE config is saved under the
// internal `household` scope key.
async function seedConfiguredHousehold(
  prefix = "worthline-agent-view-fire-",
): Promise<string> {
  const databasePath = tempDatabasePath(prefix);
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
    currentValueMinor: 100_000_00,
    id: "asset_fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: owner,
    type: "manual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 50_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: owner,
    type: "cash",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 300_000_00,
    id: "asset_home",
    isPrimaryResidence: true,
    liquidityTier: "illiquid",
    name: "Piso",
    ownership: owner,
    type: "real_estate",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 20_000_00,
    id: "asset_car",
    liquidityTier: "illiquid",
    name: "Coche",
    ownership: owner,
    type: "manual",
  });
  await store.saveFireConfig("household", {
    ...CONFIGURED,
    excludedAssetIds: ["asset_car"],
  });
  store.close();
  return databasePath;
}

async function holdingPublicId(
  databasePath: string,
  internalId: string,
): Promise<string> {
  const store = await createWorthlineStore({ databasePath });
  const publicId = (await store.agentView.readPublicIds()).find(
    (row) => row.entityType === "holding" && row.entityId === internalId,
  )!.publicId;
  store.close();
  return publicId;
}

describe("GET /api/v1/agent-view/scopes/{scopeId}/fire-context", () => {
  test("returns the FIRE config, result, eligible total, and assumptions when configured", async () => {
    await seedConfiguredHousehold();
    const scopeId = await householdScopeId();

    const { body, response } = await fireContext(scopeId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(body.data.scope.id).toBe(scopeId);
    expect(body.data.scope.type).toBe("household");
    expect(body.data.status).toBe("configured");

    expect(body.data.config).toEqual({
      monthlySpending: eur(2_000_00),
      safeWithdrawalRate: "0.04",
      expectedRealReturn: "0.05",
    });

    // Eligible = fund 100k + cash 50k = 150_000_00 (home + car excluded).
    expect(body.data.eligibleAssetsTotal).toEqual(eur(150_000_00));
    expect(body.data.result.fireNumber).toEqual(eur(FIRE_NUMBER));
    expect(body.data.result.eligibleAssets).toEqual(eur(150_000_00));
    // gap = 600_000_00 - 150_000_00 = 450_000_00 (signed).
    expect(body.data.result.gap).toEqual(eur(450_000_00));
    // progressRatio = 150_000_00 / 600_000_00 = 0.25.
    expect(body.data.result.progressRatio).toBe("0.25");

    expect(body.data.assumptions).toEqual({
      monthlySpending: eur(2_000_00),
      safeWithdrawalRate: "0.04",
      expectedRealReturn: "0.05",
    });

    expect(body.data.qualitySignals).toEqual([]);
  });

  test("lists excluded assets with both primary-residence and manual reasons", async () => {
    const databasePath = await seedConfiguredHousehold("worthline-agent-view-fire-excl-");
    const scopeId = await householdScopeId();

    const { body } = await fireContext(scopeId);
    const excluded = body.data.excludedAssets as Array<{
      holding: { id: string; object: string; label: string };
      reason: string;
    }>;

    const homePublic = await holdingPublicId(databasePath, "asset_home");
    const carPublic = await holdingPublicId(databasePath, "asset_car");

    const byId = Object.fromEntries(excluded.map((e) => [e.holding.id, e]));
    expect(byId[homePublic].reason).toBe("primary_residence");
    expect(byId[homePublic].holding.object).toBe("holding");
    expect(byId[homePublic].holding.label).toBe("Piso");
    expect(byId[carPublic].reason).toBe("manual");
    expect(byId[carPublic].holding.label).toBe("Coche");
    expect(excluded).toHaveLength(2);
  });

  test("reports an unconfigured state with a missing_configuration signal", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fire-unconf-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
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
    const { body } = await fireContext(scopeId);

    expect(body.data.status).toBe("unconfigured");
    expect(body.data.config).toBeUndefined();
    expect(body.data.result).toBeUndefined();
    expect(body.data.assumptions).toBeUndefined();
    expect(body.data.eligibleAssetsTotal).toEqual(eur(0));
    expect(body.data.excludedAssets).toEqual([]);
    expect(body.data.qualitySignals).toEqual([
      { category: "missing_configuration", message: expect.any(String) },
    ]);
  });

  test("weights eligible figures by the selected member, household, and group scope", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fire-scopes-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      groups: [
        { id: "group_adults", memberIds: ["member_ana", "member_jose"], name: "Adultos" },
      ],
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });
    // Shared account split 50/50 between Ana and Jose.
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_joint",
      liquidityTier: "cash",
      name: "Cuenta conjunta",
      ownership: [
        { memberId: "member_ana", shareBps: 5_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ],
      type: "cash",
    });
    // The household and group share the same config; Ana keeps her own.
    await store.saveFireConfig("household", CONFIGURED);
    await store.saveFireConfig("group_adults", CONFIGURED);
    await store.saveFireConfig("member_ana", CONFIGURED);
    store.close();

    const scopes = await listScopes();
    const household = scopes.find((scope) => scope.type === "household")!;
    const anaScope = scopes.find(
      (scope) => scope.type === "member" && scope.label === "Ana",
    )!;
    const groupScope = scopes.find((scope) => scope.type === "group")!;

    const householdCtx = await fireContext(household.id);
    expect(householdCtx.body.data.eligibleAssetsTotal).toEqual(eur(200_000_00));
    expect(householdCtx.body.data.result.eligibleAssets).toEqual(eur(200_000_00));

    const anaCtx = await fireContext(anaScope.id);
    expect(anaCtx.body.data.scope.type).toBe("member");
    // Ana owns half the joint account = 100_000_00.
    expect(anaCtx.body.data.eligibleAssetsTotal).toEqual(eur(100_000_00));
    expect(anaCtx.body.data.result.eligibleAssets).toEqual(eur(100_000_00));

    const groupCtx = await fireContext(groupScope.id);
    expect(groupCtx.body.data.scope.type).toBe("group");
    expect(groupCtx.body.data.eligibleAssetsTotal).toEqual(eur(200_000_00));
  });

  test("422 unsupported_historical_fire when a date is requested", async () => {
    await seedConfiguredHousehold("worthline-agent-view-fire-hist-");
    const scopeId = await householdScopeId();

    const { body, response } = await fireContext(scopeId, "?date=2025-01-01");

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.details).toEqual({ reason: "unsupported_historical_fire" });
  });

  test("rejects unknown query parameters with 400", async () => {
    await seedConfiguredHousehold("worthline-agent-view-fire-badparam-");
    const scopeId = await householdScopeId();

    const { response } = await fireContext(scopeId, "?asOf=2025-01-01");
    expect(response.status).toBe(400);
  });

  test("returns 404 for an unknown scope id", async () => {
    await seedConfiguredHousehold("worthline-agent-view-fire-404-");

    const { body, response } = await fireContext("wl_scp_doesnotexist");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("requires the local capability token", async () => {
    await seedConfiguredHousehold("worthline-agent-view-fire-auth-");
    const scopeId = await householdScopeId();

    const response = await getFireContext(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/fire-context`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(401);
  });

  test("MCP get_fire_context mirrors the HTTP shape and defaults to the household scope", async () => {
    await seedConfiguredHousehold("worthline-agent-view-fire-mcp-");

    const household = await householdScopeId();
    const httpBody = await fireContext(household);

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpDefault = await catalog.get_fire_context.invoke({});
    const mcpExplicit = await catalog.get_fire_context.invoke({ scopeId: household });

    expect(mcpDefault).toEqual(httpBody.body);
    expect(mcpExplicit).toEqual(httpBody.body);
  });

  test("reads do not mutate persisted state", async () => {
    const databasePath = await seedConfiguredHousehold(
      "worthline-agent-view-fire-nomut-",
    );
    const scopeId = await householdScopeId();

    const before = await fingerprint(databasePath);
    await fireContext(scopeId);
    await fireContext(scopeId);
    const after = await fingerprint(databasePath);

    expect(after).toBe(before);
  });
});

describe("main financial context FIRE summary (#340)", () => {
  test("folds a compact configured FIRE summary into the main context", async () => {
    await seedConfiguredHousehold("worthline-agent-view-fire-main-conf-");
    const scopeId = await householdScopeId();

    const { body } = await financialContext(scopeId);
    const fire = body.data.fire;

    expect(fire.status).toBe("configured");
    expect(fire.fireNumber).toEqual(eur(FIRE_NUMBER));
    expect(fire.eligibleAssets).toEqual(eur(150_000_00));
    expect(fire.gap).toEqual(eur(450_000_00));
    expect(fire.progressRatio).toBe("0.25");
    expect(fire.assumptions).toEqual({
      monthlySpending: eur(2_000_00),
      safeWithdrawalRate: "0.04",
      expectedRealReturn: "0.05",
    });
  });

  test("reports an unconfigured FIRE summary with status only", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fire-main-unconf-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
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
    const { body } = await financialContext(scopeId);
    const fire = body.data.fire;

    expect(fire.status).toBe("unconfigured");
    expect(fire.fireNumber).toBeUndefined();
    expect(fire.eligibleAssets).toBeUndefined();
    expect(fire.gap).toBeUndefined();
    expect(fire.progressRatio).toBeUndefined();
    expect(fire.assumptions).toBeUndefined();
  });
});
