import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getFireContext } from "@web/api/v1/agent-view/scopes/[scopeId]/fire-context/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";
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
  const store = await createWorthlineStoreUnsafe({ databasePath });
  const snapshot = JSON.stringify({
    assets: await store.assets.readAssets(),
    fireConfig: await store.readFireConfig("2026-08-18"),
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

  const store = await createWorthlineStoreUnsafe({ databasePath });
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
  const store = await createWorthlineStoreUnsafe({ databasePath });
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
      // Siempre presente (#1460): sin este campo, un ámbito que dejó su ladrillo
      // fuera y otro que lo cuenta publicarían el mismo contrato con cifras que
      // significan cosas distintas.
      immobilizedCountsAsFireCapital: true,
      // Siempre presente por la misma razón (#1428): es el umbral contra el que se mide
      // la señal del perfil, y sin verlo no se puede explicar de dónde sale.
      ordinaryRetirementAge: 65,
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

  // #1425: el contrato ganó `coastArrival` y renombró `coastFireAge`. El rename lo caza
  // `tsc`; que el campo nuevo DEJE de emitirse, no — y es exactamente la mitad del
  // ticket que un asistente consume.
  test("publishes both Coast ages, each with its own premise", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fire-coast-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 150_000_00,
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "manual",
    });
    await store.saveFireConfig("household", {
      ...CONFIGURED,
      currentAge: 45,
      monthlySavingsCapacityMinor: 500_00,
      targetRetirementAge: 65,
    });
    store.close();

    const { body } = await fireContext(await householdScopeId());
    const result = body.data.result;

    // El requisito: el número FIRE descontado 20 años al 5 %.
    expect(result.coastFireRequired).toEqual(eur(Math.round(FIRE_NUMBER / 1.05 ** 20)));
    expect(result.isAlreadyAtCoastFire).toBe(false);

    // La llegada, proyectada CON los 500 €/mes declarados.
    expect(result.coastArrival.kind).toBe("eta");
    expect(result.coastArrival.age).toBeGreaterThan(45);
    expect(result.coastArrival.age).toBeLessThan(result.fireAgeIfContributionsStop);

    // Y la de aportación cero, con su premisa en el nombre: 45 + log(4)/log(1,05).
    expect(result.fireAgeIfContributionsStop).toBeCloseTo(
      45 + Math.log(4) / Math.log(1.05),
      5,
    );
    expect(result.coastFireAge).toBeUndefined();
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

    const store = await createWorthlineStoreUnsafe({ databasePath });
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

    const store = await createWorthlineStoreUnsafe({ databasePath });
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

    const store = await createWorthlineStoreUnsafe({ databasePath });
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

// ── the rent-derived rate reaches the assistant too (#1448) ──────────────────

describe("fire-context reports the rent-derived real return", () => {
  /**
   * A household whose whole eligible pool is one rented flat, with the rent and its
   * costs declared. No manual `expectedRealReturn`: the rate is the derived one, and
   * the tool has to quote THAT — an assistant answering with the housing rung's 3 %
   * while the screen shows 4,5 % is the same figure with two values.
   */
  async function seedRentedFlat(withExpenses: boolean): Promise<void> {
    const databasePath = tempDatabasePath("worthline-agent-view-fire-rent-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_flat",
      liquidityTier: "illiquid",
      name: "Piso alquilado",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "real_estate",
    });
    await store.payouts.createPayoutSchedule({
      amountMinor: 1_000_00,
      cadence: "monthly",
      holdingId: "asset_flat",
      label: "Alquiler",
      startISO: "2024-01-01",
      ...(withExpenses ? { expensesMinor: 250_00 } : {}),
    });
    await store.saveFireConfig("household", {
      monthlySpendingMinor: 2_000_00,
      safeWithdrawalRate: 0.04,
    });
    store.close();
  }

  test("the declared net rent is the rate the tool quotes", async () => {
    // (1.000 − 250) × 12 = 9.000 €/año over 200.000 € → 4,5 %, not the housing 3 %.
    await seedRentedFlat(true);
    const scopeId = await householdScopeId();

    const { body } = await fireContext(scopeId);

    expect(body.data.assumptions.expectedRealReturn).toBe("0.045");
  });

  test("with no declared costs it stays on the tier default, never on the gross", async () => {
    // The gross would be 6 %; the tool must not report it.
    await seedRentedFlat(false);
    const scopeId = await householdScopeId();

    const { body } = await fireContext(scopeId);

    expect(body.data.assumptions.expectedRealReturn).toBe("0.03");
  });
});

// #1428: el perfil y la respuesta que lleva. Un asistente que solo leyera
// `progressRatio` le diría a Jorge «te falta el 75 %», que es exactamente el fallo del
// ticket; estos campos son la mitad del arreglo que un asistente consume.
describe("GET fire-context — el perfil de jubilación ordinaria (#1428)", () => {
  async function seedOrdinaryHousehold(
    config: Partial<FireScopeConfig> = {},
  ): Promise<void> {
    const databasePath = tempDatabasePath("worthline-agent-view-fire-ordinary-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jorge", name: "Jorge" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 100_000_00,
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: [{ memberId: "member_jorge", shareBps: 10_000 }],
      type: "manual",
    });
    await store.saveFireConfig("household", {
      ...CONFIGURED,
      currentAge: 63,
      monthlySavingsCapacityMinor: 0,
      targetRetirementAge: 67,
      ...config,
    });
    store.close();
  }

  test("publishes the signals as facts, and the state as `offer` until the user answers", async () => {
    await seedOrdinaryHousehold();

    const { body } = await fireContext(await householdScopeId());

    // Solo la señal de la edad: con 100.000 € al 5 % el número FIRE sí se cruza
    // dentro del horizonte, así que la otra señal no aplica — y eso es correcto.
    expect(body.data.result.retirementProfile).toEqual({
      signals: ["target_age_is_ordinary"],
      state: "offer",
    });
    expect(body.data.config.retirementPlan).toBeUndefined();
  });

  test("publishes the sustainable spending: net rents apart from what the sellable capital supports", async () => {
    await seedOrdinaryHousehold({ retirementPlan: "ordinary" });

    const { body } = await fireContext(await householdScopeId());
    const spending = body.data.result.sustainableSpending;

    expect(body.data.result.retirementProfile.state).toBe("ordinary");
    // 100.000 € vendibles × 4 % ÷ 12 = 333,33 €/mes; sin rentas, el total es ese.
    expect(spending.capitalMonthly).toEqual(eur(333_33));
    expect(spending.totalMonthly).toEqual(eur(333_33));
    expect(spending.rentsMonthly).toBeUndefined();
    // Sin edad final declarada no hay versión de agotamiento: no se supone ninguna.
    expect(spending.depletionMonthly).toBeUndefined();
  });

  test("the depleting variant appears only with the declared final age", async () => {
    await seedOrdinaryHousehold({ capitalLastsUntilAge: 90, retirementPlan: "ordinary" });

    const { body } = await fireContext(await householdScopeId());
    const spending = body.data.result.sustainableSpending;

    expect(body.data.config.capitalLastsUntilAge).toBe(90);
    expect(spending.untilAge).toBe(90);
    // Gastar el principal en 27 años da más que conservarlo para siempre.
    expect(spending.depletionMonthly.amountMinor).toBeGreaterThan(
      spending.totalMonthly.amountMinor,
    );
  });

  test("a declared `early` plan is published, and it silences the offer", async () => {
    await seedOrdinaryHousehold({ retirementPlan: "early" });

    const { body } = await fireContext(await householdScopeId());

    expect(body.data.config.retirementPlan).toBe("early");
    expect(body.data.result.retirementProfile.state).toBe("fire");
    // Las señales siguen publicándose: el estado es una decisión, no una negación.
    expect(body.data.result.retirementProfile.signals).toContain(
      "target_age_is_ordinary",
    );
  });
});
