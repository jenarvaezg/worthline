import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";

import { createControlPlaneStore, createWorthlineStore } from "@worthline/db";
import { debtBalanceAtDate, systemClock } from "@worthline/domain";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

const ORIGINAL_DB_PATH = process.env.WORTHLINE_DB_PATH;
const ORIGINAL_TOKEN = process.env.WORTHLINE_AGENT_VIEW_TOKEN;
const ORIGINAL_CONTROL_PLANE_DB_URL = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;

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

  if (ORIGINAL_CONTROL_PLANE_DB_URL === undefined) {
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
  } else {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = ORIGINAL_CONTROL_PLANE_DB_URL;
  }

  cleanupTempDirs();
});

function scopesRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1/api/v1/agent-view/scopes", {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
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

async function financialContext(scopeId: string, query = "") {
  const response = await getFinancialContext(financialContextRequest(scopeId, query), {
    params: Promise.resolve({ scopeId }),
  });
  return { body: await response.json(), response };
}

function eur(amountMinor: number) {
  return { amountMinor, currency: "EUR" };
}

// A fingerprint of every mutation-prone read, to prove an agent read writes
// nothing (no snapshots, price cache, public IDs, holdings).
async function fingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStore({ databasePath });
  const snapshot = JSON.stringify({
    assets: await store.assets.readAssets(),
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
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/financial-context$/,
    );
    if (match) {
      const scopeId = decodeURIComponent(match[1]);
      const response = await getFinancialContext(req, {
        params: Promise.resolve({ scopeId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

describe("GET /api/v1/agent-view/scopes/{scopeId}/financial-context", () => {
  test("returns the scope, asOf, base currency, and current headline figures", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-");
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
      name: "Cuenta corriente",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    store.close();

    const scopeId = await householdScopeId();
    const response = await getFinancialContext(financialContextRequest(scopeId), {
      params: Promise.resolve({ scopeId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(body.data.scope.id).toBe(scopeId);
    expect(body.data.scope.object).toBe("scope");
    expect(body.data.scope.type).toBe("household");
    expect(body.data.scope.isDefault).toBe(true);

    expect(body.data.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data.baseCurrency).toBe("EUR");

    expect(body.data.summary).toEqual({
      netWorth: eur(10_000_00),
      liquidNetWorth: eur(10_000_00),
      grossAssets: eur(10_000_00),
      debts: eur(0),
      housingEquity: eur(0),
    });

    expect(body.data.links).toEqual({
      snapshots: `/api/v1/agent-view/scopes/${scopeId}/snapshots`,
      fireContext: `/api/v1/agent-view/scopes/${scopeId}/fire-context`,
      dataQuality: `/api/v1/agent-view/scopes/${scopeId}/data-quality`,
      trashSummary: `/api/v1/agent-view/scopes/${scopeId}/trash-summary`,
    });
  });

  test("reports the per-rung liquidity breakdown alongside the headline figures", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-liq-");
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
      id: "asset_market",
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
    await store.liabilities.createLiability({
      associatedAssetId: "asset_home",
      balanceMinor: 100_000_00,
      currency: "EUR",
      id: "liab_mortgage",
      name: "Hipoteca",
      ownership: owner,
      type: "mortgage",
    });
    store.close();

    const { body } = await financialContext(await householdScopeId());

    expect(body.data.summary).toEqual({
      netWorth: eur(130_000_00),
      liquidNetWorth: eur(30_000_00),
      grossAssets: eur(230_000_00),
      debts: eur(100_000_00),
      housingEquity: eur(100_000_00),
    });

    const rungs = body.data.liquidityBreakdown as Array<{
      tier: string;
      netValue: { amountMinor: number };
      grossAssets: { amountMinor: number };
      debts: { amountMinor: number };
      shareOfGross: string;
    }>;
    expect(rungs.map((rung) => rung.tier)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
    const byTier = Object.fromEntries(rungs.map((rung) => [rung.tier, rung]));
    expect(byTier.cash.grossAssets).toEqual(eur(10_000_00));
    expect(byTier.market.grossAssets).toEqual(eur(20_000_00));
    expect(byTier.housing.grossAssets).toEqual(eur(200_000_00));
    expect(byTier.housing.debts).toEqual(eur(100_000_00));
    expect(byTier.housing.netValue).toEqual(eur(100_000_00));
    expect(byTier["term-locked"].grossAssets).toEqual(eur(0));
    for (const rung of rungs) {
      expect(rung.shareOfGross).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  async function seedHoldings(): Promise<void> {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-holdings-");
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
      currentValueMinor: 30_000_00,
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: owner,
      type: "manual",
    });
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
      currentValueMinor: 1_000_00,
      id: "asset_watch",
      liquidityTier: "illiquid",
      name: "Reloj",
      ownership: owner,
      type: "manual",
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
  }

  test("summarizes holdings sorted by absolute value with opaque IDs and ownership", async () => {
    await seedHoldings();

    const { body } = await financialContext(await householdScopeId());
    const holdings = body.data.holdings;

    expect(holdings.limit).toBe(25);
    expect(holdings.omittedCount).toBe(0);
    expect(holdings.omittedTotalValue).toEqual(eur(0));

    expect(holdings.items.map((h: { label: string }) => h.label)).toEqual([
      "Fondo",
      "Cuenta",
      "Préstamo",
      "Reloj",
    ]);

    const fondo = holdings.items[0];
    expect(fondo.id).toMatch(/^wl_hld_/);
    expect(fondo.object).toBe("holding");
    expect(fondo.direction).toBe("asset");
    expect(fondo.liquidityTier).toBe("market");
    expect(fondo.currentValue).toEqual(eur(30_000_00));
    expect(typeof fondo.instrument).toBe("string");
    expect(typeof fondo.valuationMethod).toBe("string");
    expect(fondo.ownership).toEqual([
      {
        member: {
          id: expect.stringMatching(/^wl_mbr_/),
          object: "member",
          label: "Jose",
        },
        share: "1",
      },
    ]);

    const loan = holdings.items.find((h: { label: string }) => h.label === "Préstamo");
    expect(loan.direction).toBe("liability");
    expect(loan.currentValue).toEqual(eur(5_000_00));
  });

  test("caps holdings at holdingLimit and reports omitted count and total value", async () => {
    await seedHoldings();

    const { body } = await financialContext(await householdScopeId(), "?holdingLimit=2");
    const holdings = body.data.holdings;

    expect(holdings.limit).toBe(2);
    expect(holdings.items.map((h: { label: string }) => h.label)).toEqual([
      "Fondo",
      "Cuenta",
    ]);
    expect(holdings.omittedCount).toBe(2);
    // Préstamo (5_000_00) + Reloj (1_000_00) dropped by the cap.
    expect(holdings.omittedTotalValue).toEqual(eur(6_000_00));
  });

  test("reports an exposure summary with top holdings, allocations, and concentration", async () => {
    await seedHoldings();

    const { body } = await financialContext(await householdScopeId());
    const exposure = body.data.exposure;

    // Gross assets = 41_000_00 (Fondo 30k + Cuenta 10k + Reloj 1k); liabilities excluded.
    expect(exposure.topHoldings.map((h: { label: string }) => h.label)).toEqual([
      "Fondo",
      "Cuenta",
      "Reloj",
    ]);
    expect(exposure.topHoldings[0]).toEqual({
      id: expect.stringMatching(/^wl_hld_/),
      object: "holding",
      label: "Fondo",
      value: eur(30_000_00),
      weight: "0.7317",
    });
    expect(exposure.concentration.topHoldingWeight).toBe("0.7317");
    expect(exposure.concentration.topFiveWeight).toMatch(/^[01](\.\d+)?$/);

    const market = exposure.byLiquidityTier.find(
      (s: { key: string }) => s.key === "market",
    );
    expect(market.value).toEqual(eur(30_000_00));
    for (const slice of exposure.byInstrument) {
      expect(slice.weight).toMatch(/^[01](\.\d+)?$/);
    }
  });

  test("folds operation summaries and connected-source summaries into the context", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-ops-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: owner,
    });
    const buy = async (
      executedAt: string,
      units: string,
      price: string,
      feesMinor = 0,
      kind = "buy",
    ) =>
      await store.recordOperationAndRipple(
        {
          assetId: "asset_fund",
          currency: "EUR",
          executedAt,
          feesMinor,
          id: `op_${executedAt}`,
          kind: kind as "buy" | "sell",
          pricePerUnit: price,
          units,
        },
        { today: "2026-06-19" },
      );
    await buy("2026-01-10", "10", "100.00", 5_00);
    await buy("2026-02-15", "5", "120.00");
    await buy("2026-03-20", "3", "130.00", 0, "sell");

    await store.connectedSources.connect({
      adapter: "numista",
      credentialsJson: JSON.stringify({ apiKey: "secret-key" }),
      label: "Colección Numista",
      ownership: owner,
    });
    store.close();

    const { body } = await financialContext(await householdScopeId());

    const fund = body.data.holdings.items.find(
      (h: { label: string }) => h.label === "Fondo indexado",
    );
    expect(fund.operationSummary).toEqual({
      operationCount: 3,
      firstOperationDate: "2026-01-10",
      latestOperationDate: "2026-03-20",
      unitsBought: "15",
      unitsSold: "3",
      grossBuyAmount: eur(1_600_00),
      grossSellAmount: eur(390_00),
      feesTotal: eur(5_00),
    });
    expect(body.data.returns.simple.totalGain).toEqual(eur(69_00));
    expect(body.data.returns.simple.realizedGain).toBeUndefined();
    expect(Number(body.data.returns.simple.totalReturnRatio)).toBeCloseTo(
      69_00 / 1_605_00,
      10,
    );
    expect(body.data.returns.moneyWeighted.reason).toBeNull();
    expect(
      body.data.returns.qualitySignals.map((signal: { code: string }) => signal.code),
    ).toContain("DISTRIBUTIONS_NOT_CAPTURED");

    const sources = body.data.connectedSources;
    expect(sources).toHaveLength(1);
    expect(sources[0].adapter).toBe("numista");
    expect(sources[0].label).toBe("Colección Numista");
    expect(sources[0].projectedHoldings.length).toBeGreaterThan(0);
    expect(sources[0].projectedHoldings[0].id).toMatch(/^wl_hld_/);
    // Credentials must never leak through the summary.
    expect(JSON.stringify(sources)).not.toContain("secret-key");
  });

  test("MCP get_financial_context mirrors the HTTP shape and defaults to the household scope", async () => {
    await seedHoldings();

    const household = await householdScopeId();
    const httpBody = await financialContext(household);

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpDefault = await catalog.get_financial_context.invoke({});
    const mcpExplicit = await catalog.get_financial_context.invoke({
      scopeId: household,
    });

    // Omitting scopeId resolves to the household, and the MCP envelope is
    // byte-identical to the HTTP envelope (no contract drift).
    expect(mcpDefault).toEqual(httpBody.body);
    expect(mcpExplicit).toEqual(httpBody.body);

    const capped = await catalog.get_financial_context.invoke({ holdingLimit: 2 });
    expect(capped.data.holdings.limit).toBe(2);
    expect(capped.data.holdings.omittedCount).toBe(2);
  });

  test("exposes net-worth vs inflation with honest IPC coverage", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-inflation-");
    const controlPlanePath = tempDatabasePath("worthline-control-plane-inflation-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = `file:${controlPlanePath}`;

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.snapshots.saveSnapshot({
      snapshot: {
        capturedAt: "2024-01-31T20:00:00.000Z",
        dateKey: "2024-01-31",
        debts: eur(0),
        grossAssets: eur(100_000_00),
        housingEquity: eur(0),
        id: "snap_2024_01_31",
        isMonthlyClose: true,
        liquidNetWorth: eur(100_000_00),
        monthKey: "2024-01",
        scopeId: "household",
        scopeLabel: "Hogar",
        totalNetWorth: eur(100_000_00),
        warnings: [],
      },
    });
    await store.snapshots.saveSnapshot({
      snapshot: {
        capturedAt: "2024-03-31T20:00:00.000Z",
        dateKey: "2024-03-31",
        debts: eur(0),
        grossAssets: eur(130_000_00),
        housingEquity: eur(0),
        id: "snap_2024_03_31",
        isMonthlyClose: true,
        liquidNetWorth: eur(130_000_00),
        monthKey: "2024-03",
        scopeId: "household",
        scopeLabel: "Hogar",
        totalNetWorth: eur(130_000_00),
        warnings: [],
      },
    });
    store.close();

    const controlPlane = await createControlPlaneStore({
      url: `file:${controlPlanePath}`,
    });
    await controlPlane.upsertBenchmarkPrices("ipc-es", [
      { dateKey: "2024-01-01", value: "100" },
      { dateKey: "2024-03-01", value: "110" },
    ]);
    controlPlane.close();

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const body = await catalog.get_financial_context.invoke({});

    expect(body.data.vsInflation).toEqual({
      comparison: {
        cpiGrowth: expect.closeTo(0.1),
        netWorthGrowth: expect.closeTo(0.3),
        realGrowth: expect.closeTo(0.18181818181818182),
        sinceDate: "2024-01-31",
        untilDate: "2024-03-31",
      },
      coverage: { source: "IPC-ES", cadence: "monthly" },
      unavailableReason: null,
    });
  });

  test("returns 404 for an unknown scope id", async () => {
    await seedHoldings();

    const { response, body } = await financialContext("wl_scp_doesnotexist");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("rejects unknown query parameters and invalid holdingLimit", async () => {
    await seedHoldings();
    const scopeId = await householdScopeId();

    expect((await financialContext(scopeId, "?foo=bar")).response.status).toBe(400);
    expect((await financialContext(scopeId, "?holdingLimit=0")).response.status).toBe(
      400,
    );
    expect((await financialContext(scopeId, "?holdingLimit=abc")).response.status).toBe(
      400,
    );

    // Over the max clamps to 100 rather than erroring.
    const clamped = await financialContext(scopeId, "?holdingLimit=999");
    expect(clamped.response.status).toBe(200);
    expect(clamped.body.data.holdings.limit).toBe(100);
  });

  test("requires the local capability token", async () => {
    await seedHoldings();
    const scopeId = await householdScopeId();

    const response = await getFinancialContext(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/financial-context`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(401);
  });

  test("reads do not mutate persisted state", async () => {
    await seedHoldings();
    const databasePath = process.env.WORTHLINE_DB_PATH as string;
    const scopeId = await householdScopeId();

    const before = await fingerprint(databasePath);
    await financialContext(scopeId);
    await financialContext(scopeId, "?holdingLimit=1");
    const after = await fingerprint(databasePath);

    expect(after).toBe(before);
  });

  test("weights figures by ownership for explicit member and group scopes", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-scopes-");
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
    // One shared account split 50/50 between Ana and Jose.
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

    const householdCtx = await financialContext(household.id);
    expect(householdCtx.body.data.summary.grossAssets).toEqual(eur(10_000_00));

    const anaCtx = await financialContext(anaScope.id);
    expect(anaCtx.response.status).toBe(200);
    expect(anaCtx.body.data.scope.type).toBe("member");
    expect(anaCtx.body.data.scope.isDefault).toBe(false);
    expect(anaCtx.body.data.summary.grossAssets).toEqual(eur(5_000_00));
    expect(anaCtx.body.data.summary.netWorth).toEqual(eur(5_000_00));

    const groupCtx = await financialContext(groupScope.id);
    expect(groupCtx.body.data.scope.type).toBe("group");
    expect(groupCtx.body.data.summary.grossAssets).toEqual(eur(10_000_00));
  });

  test("values amortizable debts on the curve, not the stored balance", async () => {
    // Regression (2026-07-03): an early repayment was recorded but every
    // agent-view figure kept echoing the stored current balance — the curve
    // (plan + repayments) is the live figure the dashboard shows.
    const databasePath = tempDatabasePath("worthline-agent-view-fc-curve-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const plan = {
      annualInterestRate: "0.0589",
      disbursementDate: "2026-05-08",
      firstPaymentDate: "2026-06-08",
      initialCapitalMinor: 6_000_00,
      termMonths: 42,
    };
    const repayment = {
      amountMinor: 154_34,
      mode: "reduce-term" as const,
      repaymentDate: "2026-07-03",
    };
    const storedBalanceMinor = 5_879_18;

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.liabilities.createLiability({
      balanceMinor: storedBalanceMinor,
      currency: "EUR",
      id: "liab_loan",
      name: "Préstamo Revolut",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "loan",
    });
    await store.liabilities.setDebtModel("liab_loan", "amortizable");
    await store.liabilities.createAmortizationPlan({
      ...plan,
      id: "amp_loan",
      liabilityId: "liab_loan",
    });
    await store.liabilities.addEarlyRepayment({
      ...repayment,
      id: "erp_loan",
      planId: "amp_loan",
    });
    store.close();

    // The expected figure is the SAME domain curve at the SAME date the route
    // values with, so the assertion is deterministic on any test day.
    const expectedBalanceMinor = debtBalanceAtDate({
      currentBalanceMinor: storedBalanceMinor,
      debtModel: "amortizable",
      earlyRepayments: [repayment],
      plan,
      targetDate: systemClock().today(),
    });

    const { body } = await financialContext(await householdScopeId());

    expect(expectedBalanceMinor).not.toBe(storedBalanceMinor);
    expect(body.data.summary.debts).toEqual(eur(expectedBalanceMinor));
    const loan = body.data.holdings.items.find(
      (h: { label: string }) => h.label === "Préstamo Revolut",
    );
    expect(loan.currentValue).toEqual(eur(expectedBalanceMinor));
  });
});
