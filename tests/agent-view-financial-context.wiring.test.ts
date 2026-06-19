import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";

import { createWorthlineStore } from "@worthline/db";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import type { AgentViewApiClient } from "@web/agent-view/mcp";
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
function fingerprint(databasePath: string): string {
  const store = createWorthlineStore({ databasePath });
  const snapshot = JSON.stringify({
    assets: store.assets.readAssets(),
    liabilities: store.liabilities.readLiabilities(),
    priceCache: store.operations.readAllPriceCacheEntries(),
    publicIds: store.agentView.readPublicIds(),
    snapshots: store.snapshots.readSnapshots("household"),
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

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: owner,
      type: "cash",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 20_000_00,
      id: "asset_market",
      liquidityTier: "market",
      name: "Fondo",
      ownership: owner,
      type: "manual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 200_000_00,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: owner,
      type: "real_estate",
    });
    store.liabilities.createLiability({
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

  function seedHoldings() {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-holdings-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 30_000_00,
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo",
      ownership: owner,
      type: "manual",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: owner,
      type: "cash",
    });
    store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "asset_watch",
      liquidityTier: "illiquid",
      name: "Reloj",
      ownership: owner,
      type: "manual",
    });
    store.liabilities.createLiability({
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
    seedHoldings();

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
    seedHoldings();

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
    seedHoldings();

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

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
    store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: owner,
    });
    const buy = (
      executedAt: string,
      units: string,
      price: string,
      feesMinor = 0,
      kind = "buy",
    ) =>
      store.recordOperationAndRipple(
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
    buy("2026-01-10", "10", "100.00", 5_00);
    buy("2026-02-15", "5", "120.00");
    buy("2026-03-20", "3", "130.00", 0, "sell");

    store.connectedSources.connect({
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
    seedHoldings();

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

  test("returns 404 for an unknown scope id", async () => {
    seedHoldings();

    const { response, body } = await financialContext("wl_scp_doesnotexist");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("rejects unknown query parameters and invalid holdingLimit", async () => {
    seedHoldings();
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
    seedHoldings();
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
    seedHoldings();
    const databasePath = process.env.WORTHLINE_DB_PATH as string;
    const scopeId = await householdScopeId();

    const before = fingerprint(databasePath);
    await financialContext(scopeId);
    await financialContext(scopeId, "?holdingLimit=1");
    const after = fingerprint(databasePath);

    expect(after).toBe(before);
  });

  test("weights figures by ownership for explicit member and group scopes", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-fc-scopes-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = createWorthlineStore({ databasePath });
    store.workspace.initializeWorkspace({
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
    store.assets.createManualAsset({
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
});
