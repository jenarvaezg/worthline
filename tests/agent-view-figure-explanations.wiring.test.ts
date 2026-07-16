import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getFigureExplanation } from "@web/api/v1/agent-view/scopes/[scopeId]/figure-explanations/[figure]/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStoreUnsafe } from "@worthline/db";
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

function explanationRequest(scopeId: string, figure: string, query = ""): NextRequest {
  return new NextRequest(
    `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/figure-explanations/${figure}${query}`,
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

async function explain(scopeId: string, figure: string, query = "") {
  const response = await getFigureExplanation(
    explanationRequest(scopeId, figure, query),
    { params: Promise.resolve({ figure, scopeId }) },
  );
  return { body: await response.json(), response };
}

function eur(amountMinor: number) {
  return { amountMinor, currency: "EUR" };
}

// A fingerprint of every mutation-prone read, to prove an explanation read
// writes nothing (no snapshots, price cache, public IDs, holdings, FIRE config).
async function fingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStoreUnsafe({ databasePath });
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

    const match = url.pathname.match(
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/figure-explanations\/([^/]+)$/,
    );
    if (match) {
      const scopeId = decodeURIComponent(match[1]);
      const figure = decodeURIComponent(match[2]);
      const response = await getFigureExplanation(req, {
        params: Promise.resolve({ figure, scopeId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

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

// Seed a household with a cash account, a market fund, a primary residence with a
// housing-securing mortgage, and an unsecured loan. Net worth = 232k - 105k.
async function seedHousehold(prefix = "worthline-agent-view-figexp-"): Promise<string> {
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
    currentValueMinor: 10_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: owner,
    type: "cash",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 20_000_00,
    id: "asset_fund",
    liquidityTier: "market",
    name: "Fondo",
    ownership: owner,
    type: "manual",
  });
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
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 2_000_00,
    id: "asset_watch",
    liquidityTier: "illiquid",
    name: "Reloj",
    ownership: owner,
    type: "manual",
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
  await store.liabilities.createLiability({
    balanceMinor: 5_000_00,
    currency: "EUR",
    id: "liab_loan",
    name: "Préstamo",
    ownership: owner,
    type: "debt",
  });
  store.close();
  return databasePath;
}

const CONFIGURED = {
  expectedRealReturn: 0.05,
  monthlySpendingMinor: 2_000_00,
  safeWithdrawalRate: 0.04,
};
// fireNumber = 2_000_00 * 12 / 0.04 = 600_000_00.
const FIRE_NUMBER = 600_000_00;

// Seed a household with a FIRE config (home excluded as primary residence).
async function seedFireHousehold(
  prefix = "worthline-agent-view-figexp-fire-",
): Promise<string> {
  const databasePath = await seedHousehold(prefix);
  const store = await createWorthlineStoreUnsafe({ databasePath });
  await store.saveFireConfig("household", {
    ...CONFIGURED,
    excludedAssetIds: ["asset_watch"],
  });
  store.close();
  return databasePath;
}

describe("GET /api/v1/agent-view/scopes/{scopeId}/figure-explanations/{figure}", () => {
  test("explains net_worth as grossAssets − debts with included assets and the debts operand", async () => {
    await seedHousehold("worthline-agent-view-figexp-nw-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "net_worth");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(body.data.scope.id).toBe(scopeId);
    expect(body.data.figure).toBe("net_worth");
    expect(body.data.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // grossAssets 232k - debts 105k = 127k.
    expect(body.data.value).toEqual(eur(127_000_00));

    expect(body.data.formula.expression).toBe("grossAssets − debts");
    expect(body.data.formula.operands).toEqual([
      { label: "grossAssets", value: eur(232_000_00) },
      { label: "debts", value: eur(105_000_00) },
    ]);

    // Every owned asset appears as an included holding with its scoped value.
    const includedLabels = body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(includedLabels).toEqual(["Cuenta", "Fondo", "Piso", "Reloj"]);
    for (const item of body.data.includedHoldings) {
      expect(item.holding.id).toMatch(/^wl_hld_/);
      expect(item.holding.object).toBe("holding");
    }

    // Liabilities are the excluded side (they net down, not part of gross assets).
    const excludedLabels = body.data.excludedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(excludedLabels).toEqual(["Hipoteca", "Préstamo"]);
    for (const item of body.data.excludedHoldings) {
      expect(typeof item.reason).toBe("string");
    }

    expect(body.data.links.financialContext).toBe(
      `/api/v1/agent-view/scopes/${scopeId}/financial-context`,
    );
    expect(Array.isArray(body.data.qualityNotes)).toBe(true);
  });

  test("explains gross_assets as the sum of the scope's asset holdings", async () => {
    await seedHousehold("worthline-agent-view-figexp-ga-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "gross_assets");

    expect(body.data.value).toEqual(eur(232_000_00));
    expect(body.data.formula.expression).toBe("sum(assetHoldings)");
    const sum = body.data.includedHoldings.reduce(
      (acc: number, h: { value: { amountMinor: number } }) => acc + h.value.amountMinor,
      0,
    );
    expect(sum).toBe(232_000_00);
    expect(body.data.includedHoldings).toHaveLength(4);
    expect(body.data.excludedHoldings).toEqual([]);
  });

  test("explains debts as the sum of the scope's liability holdings", async () => {
    await seedHousehold("worthline-agent-view-figexp-debt-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "debts");

    expect(body.data.value).toEqual(eur(105_000_00));
    expect(body.data.formula.expression).toBe("sum(liabilityHoldings)");
    const labels = body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(labels).toEqual(["Hipoteca", "Préstamo"]);
  });

  test("explains liquid_net_worth as liquid assets − liquid non-housing debts", async () => {
    await seedHousehold("worthline-agent-view-figexp-lnw-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "liquid_net_worth");

    // Liquid assets = cash 10k + market 20k = 30k. The loan is unsecured (cash
    // rung, liquid). Liquid net worth = 30k - 5k = 25k.
    expect(body.data.value).toEqual(eur(25_000_00));
    expect(body.data.formula.expression).toBe("liquidAssets − liquidDebts");

    const includedLabels = body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(includedLabels).toEqual(["Cuenta", "Fondo"]);

    // Excluded = the illiquid/housing assets (out of the liquid rungs).
    const excludedLabels = body.data.excludedHoldings.map(
      (h: { holding: { label: string } }) => h.holding.label,
    );
    expect(excludedLabels).toContain("Piso");
    expect(excludedLabels).toContain("Reloj");
    // The liquid loan is netted, not excluded.
    expect(includedLabels).not.toContain("Préstamo");
  });

  test("explains housing_equity as housing assets − housing-securing debts", async () => {
    await seedHousehold("worthline-agent-view-figexp-he-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "housing_equity");

    // Home 200k - mortgage 100k = 100k.
    expect(body.data.value).toEqual(eur(100_000_00));
    expect(body.data.formula.expression).toBe("housingAssets − housingDebts");

    const includedLabels = body.data.includedHoldings.map(
      (h: { holding: { label: string } }) => h.holding.label,
    );
    expect(includedLabels).toEqual(["Piso"]);

    const excludedLabels = body.data.excludedHoldings.map(
      (h: { holding: { label: string } }) => h.holding.label,
    );
    // Non-housing assets are excluded; the mortgage is the netting debt (excluded
    // from assets, surfaced as the securing debt).
    expect(excludedLabels).toContain("Cuenta");
    expect(excludedLabels).toContain("Hipoteca");
  });

  test("explains liquidity_breakdown as the per-rung breakdown reusing buildLiquidityBreakdown", async () => {
    await seedHousehold("worthline-agent-view-figexp-liq-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "liquidity_breakdown");

    expect(body.data.formula.expression).toBe("perRungNet(grossAssets − debts)");
    const rungs = body.data.value as Array<{ tier: string; netValue: unknown }>;
    expect(rungs.map((r) => r.tier)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
    const byTier = Object.fromEntries(rungs.map((r) => [r.tier, r]));
    // Cash rung: account 10k - unsecured loan 5k (lands on cash) = 5k.
    expect(byTier.cash.netValue).toEqual(eur(5_000_00));
    expect(byTier.cash.grossAssets).toEqual(eur(10_000_00));
    // Housing rung: home 200k - mortgage 100k = 100k.
    expect(byTier.housing.netValue).toEqual(eur(100_000_00));

    // Included holdings carry the rung in their reason-like label; every owned
    // holding appears.
    const includedLabels = body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(includedLabels).toEqual([
      "Cuenta",
      "Fondo",
      "Hipoteca",
      "Piso",
      "Préstamo",
      "Reloj",
    ]);
  });

  test("explains holding_value for a selected holding with its valuation method", async () => {
    const databasePath = await seedHousehold("worthline-agent-view-figexp-hv-");
    const scopeId = await householdScopeId();
    const fundPublic = await holdingPublicId(databasePath, "asset_fund");

    const { body, response } = await explain(
      scopeId,
      "holding_value",
      `?holdingId=${fundPublic}`,
    );

    expect(response.status).toBe(200);
    expect(body.data.figure).toBe("holding_value");
    expect(body.data.value).toEqual(eur(20_000_00));
    expect(body.data.includedHoldings).toHaveLength(1);
    expect(body.data.includedHoldings[0].holding.id).toBe(fundPublic);
    expect(typeof body.data.formula.expression).toBe("string");
    // The valuation method drives the explanation; freshness present for the value.
    expect(body.data.freshness).toBeDefined();
  });

  test("holding_value without a holdingId is a 400 bad_request (missing_holding_id)", async () => {
    await seedHousehold("worthline-agent-view-figexp-hv-missing-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "holding_value");

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details).toEqual({ reason: "missing_holding_id" });
  });

  test("holding_value with an unknown holdingId is a 404", async () => {
    await seedHousehold("worthline-agent-view-figexp-hv-unknown-");
    const scopeId = await householdScopeId();

    const { response } = await explain(
      scopeId,
      "holding_value",
      "?holdingId=wl_hld_doesnotexist",
    );

    expect(response.status).toBe(404);
  });

  test("holding_value for a holding the scope does not own is 422 unsupported_figure", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-figexp-hv-notowned-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      groups: [{ id: "group_x", memberIds: ["member_ana"], name: "Solo Ana" }],
      members: [
        { id: "member_ana", name: "Ana" },
        { id: "member_jose", name: "Jose" },
      ],
      mode: "household",
    });
    // An asset owned 100% by Jose; the member scope "Ana" owns none of it.
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_jose",
      liquidityTier: "cash",
      name: "Cuenta Jose",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    store.close();

    const josePublic = await holdingPublicId(databasePath, "asset_jose");
    const scopes = await listScopes();
    const anaScope = scopes.find(
      (scope) => scope.type === "member" && scope.label === "Ana",
    )!;

    const { body, response } = await explain(
      anaScope.id,
      "holding_value",
      `?holdingId=${josePublic}`,
    );

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.details).toEqual({
      figure: "holding_value",
      reason: "unsupported_figure",
    });
  });

  test("explains fire_eligible_assets with included eligible and excluded assets", async () => {
    const databasePath = await seedFireHousehold("worthline-agent-view-figexp-fea-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "fire_eligible_assets");

    // Eligible = cash 10k + fund 20k − loan 5k (netted, #51362ac) = 25k
    // (home + watch excluded; the mortgage stays with the excluded home).
    expect(body.data.value).toEqual(eur(25_000_00));
    expect(body.data.formula.expression).toBe("sum(fireEligibleAssets)");

    const includedLabels = body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(includedLabels).toEqual(["Cuenta", "Fondo"]);

    const homePublic = await holdingPublicId(databasePath, "asset_home");
    const excludedById = Object.fromEntries(
      body.data.excludedHoldings.map((h: { holding: { id: string }; reason: string }) => [
        h.holding.id,
        h.reason,
      ]),
    );
    expect(excludedById[homePublic]).toBe("primary_residence");
  });

  test("explains fire_progress as eligibleAssets/fireNumber with current FIRE assumptions", async () => {
    await seedFireHousehold("worthline-agent-view-figexp-fp-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "fire_progress");

    // 25k / 600k = 0.0417 (eligible is net of the unsecured loan, #51362ac).
    expect(body.data.value).toEqual({ ratio: "0.0417" });
    expect(body.data.formula.expression).toBe("eligibleAssets ÷ fireNumber");
    expect(body.data.formula.operands).toEqual([
      { label: "eligibleAssets", value: eur(25_000_00) },
      { label: "fireNumber", value: eur(FIRE_NUMBER) },
    ]);
    expect(body.data.assumptions).toEqual({
      monthlySpending: eur(2_000_00),
      safeWithdrawalRate: "0.04",
      expectedRealReturn: "0.05",
    });
  });

  test("fire_eligible_assets is 422 unsupported_figure when FIRE is unconfigured", async () => {
    await seedHousehold("worthline-agent-view-figexp-fea-unconf-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "fire_eligible_assets");

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.details).toEqual({
      figure: "fire_eligible_assets",
      reason: "unsupported_figure",
    });
  });

  test("fire_progress is 422 unsupported_figure when FIRE is unconfigured", async () => {
    await seedHousehold("worthline-agent-view-figexp-fp-unconf-");
    const scopeId = await householdScopeId();

    const { response } = await explain(scopeId, "fire_progress");

    expect(response.status).toBe(422);
  });

  test("an invalid figure name is a 400 invalid_figure", async () => {
    await seedHousehold("worthline-agent-view-figexp-invalid-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "not_a_figure");

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details).toEqual({
      figure: "not_a_figure",
      reason: "invalid_figure",
    });
  });

  test("surfaces a quality note for a zero-value asset on gross_assets", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-figexp-quality-");
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
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: owner,
      type: "cash",
    });
    // A zero-value asset raises a domain warning that surfaces as a quality note.
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_zero",
      liquidityTier: "market",
      name: "Fondo vacío",
      ownership: owner,
      type: "manual",
    });
    store.close();

    const scopeId = await householdScopeId();
    const { body } = await explain(scopeId, "gross_assets");

    expect(body.data.qualityNotes.length).toBeGreaterThan(0);
    expect(
      body.data.qualityNotes.some(
        (note: { category: string }) => note.category === "warning",
      ),
    ).toBe(true);
  });

  test("surfaces a connected-source source_freshness signal in net_worth qualityNotes", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-figexp-src-freshness-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    // Connect a Binance source so it materialises a market rung backing asset.
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
          balance: "1",
          currency: "EUR",
          externalId: "BTC:spot",
          kind: "token",
          liquidityTier: "market",
          name: "BTC",
          symbol: "BTC",
          unitPrice: null,
          wallet: "spot",
        },
      ],
      "2026-06-16T10:00:00.000Z",
    );
    // Revalue with a stale freshness to emit a source_freshness signal.
    const positions = await store.connectedSources.readPositions(binance.sourceId);
    await store.connectedSources.revaluePositions(
      binance.sourceId,
      positions.map((p) => ({
        id: p.id,
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
    store.close();

    const scopeId = await householdScopeId();
    const { body } = await explain(scopeId, "net_worth");

    const sourceSignal = body.data.qualityNotes.find(
      (note: { category: string }) => note.category === "source_freshness",
    );
    expect(sourceSignal).toBeDefined();
  });

  test("holding_value for a liability has no freshness field", async () => {
    const databasePath = await seedHousehold("worthline-agent-view-figexp-hv-liab-");
    const scopeId = await householdScopeId();
    const mortgagePublic = await holdingPublicId(databasePath, "liab_mortgage");

    const { body, response } = await explain(
      scopeId,
      "holding_value",
      `?holdingId=${mortgagePublic}`,
    );

    expect(response.status).toBe(200);
    expect(body.data.figure).toBe("holding_value");
    expect(body.data.value).toEqual(eur(100_000_00));
    // Liabilities are not provider-priced; freshness must not be present.
    expect(body.data.freshness).toBeUndefined();
  });

  test("weights figures by the selected member and group scope", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-figexp-scopes-");
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
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_joint",
      liquidityTier: "cash",
      name: "Cuenta conjunta",
      ownership: [
        { memberId: "member_ana", shareBps: 5_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ],
      type: "cash",
    });
    store.close();

    const scopes = await listScopes();
    const household = scopes.find((scope) => scope.type === "household")!;
    const anaScope = scopes.find(
      (scope) => scope.type === "member" && scope.label === "Ana",
    )!;
    const groupScope = scopes.find((scope) => scope.type === "group")!;

    const householdGa = await explain(household.id, "gross_assets");
    expect(householdGa.body.data.value).toEqual(eur(10_000_00));

    const anaGa = await explain(anaScope.id, "gross_assets");
    expect(anaGa.body.data.scope.type).toBe("member");
    expect(anaGa.body.data.value).toEqual(eur(5_000_00));

    const groupGa = await explain(groupScope.id, "gross_assets");
    expect(groupGa.body.data.scope.type).toBe("group");
    expect(groupGa.body.data.value).toEqual(eur(10_000_00));
  });

  test("a date with no exact snapshot is a 404 snapshot_not_found (#344)", async () => {
    await seedHousehold("worthline-agent-view-figexp-date-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "net_worth", "?date=2025-01-01");
    expect(response.status).toBe(404);
    expect(body.error.details.reason).toBe("snapshot_not_found");
  });

  test("a malformed date query is a 400 bad_request", async () => {
    await seedHousehold("worthline-agent-view-figexp-baddate-");
    const scopeId = await householdScopeId();

    const { response } = await explain(scopeId, "net_worth", "?date=not-a-date");
    expect(response.status).toBe(400);
  });

  test("returns 404 for an unknown scope id", async () => {
    await seedHousehold("worthline-agent-view-figexp-404-");

    const { body, response } = await explain("wl_scp_doesnotexist", "net_worth");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("requires the local capability token", async () => {
    await seedHousehold("worthline-agent-view-figexp-auth-");
    const scopeId = await householdScopeId();

    const response = await getFigureExplanation(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/figure-explanations/net_worth`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ figure: "net_worth", scopeId }) },
    );

    expect(response.status).toBe(401);
  });

  test("MCP explain_figure mirrors the HTTP shape and defaults to the household scope", async () => {
    await seedFireHousehold("worthline-agent-view-figexp-mcp-");

    const household = await householdScopeId();
    const httpBody = await explain(household, "net_worth");

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpDefault = await catalog.explain_figure.invoke({ figure: "net_worth" });
    const mcpExplicit = await catalog.explain_figure.invoke({
      figure: "net_worth",
      scopeId: household,
    });

    expect(mcpDefault).toEqual(httpBody.body);
    expect(mcpExplicit).toEqual(httpBody.body);
  });

  test("MCP explain_figure threads the holdingId selector through", async () => {
    const databasePath = await seedHousehold("worthline-agent-view-figexp-mcp-hv-");
    const household = await householdScopeId();
    const fundPublic = await holdingPublicId(databasePath, "asset_fund");

    const httpBody = await explain(
      household,
      "holding_value",
      `?holdingId=${fundPublic}`,
    );

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcp = await catalog.explain_figure.invoke({
      figure: "holding_value",
      holdingId: fundPublic,
      scopeId: household,
    });

    expect(mcp).toEqual(httpBody.body);
  });

  test("reads do not mutate persisted state", async () => {
    const databasePath = await seedFireHousehold("worthline-agent-view-figexp-nomut-");
    const scopeId = await householdScopeId();

    const before = await fingerprint(databasePath);
    await explain(scopeId, "net_worth");
    await explain(scopeId, "fire_progress");
    await explain(scopeId, "liquidity_breakdown");
    const after = await fingerprint(databasePath);

    expect(after).toBe(before);
  });
});
