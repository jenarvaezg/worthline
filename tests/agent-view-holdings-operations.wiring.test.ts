import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";

import { createWorthlineStore } from "@worthline/db";
import { GET as getScopes } from "../apps/web/app/api/v1/agent-view/scopes/route";
import { GET as getHolding } from "../apps/web/app/api/v1/agent-view/holdings/[holdingId]/route";
import { GET as getOperations } from "../apps/web/app/api/v1/agent-view/holdings/[holdingId]/operations/route";
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

async function holding(holdingId: string) {
  const response = await getHolding(
    authedRequest(`/api/v1/agent-view/holdings/${holdingId}`),
    { params: Promise.resolve({ holdingId }) },
  );
  return { body: await response.json(), response };
}

async function operations(holdingId: string, query = "") {
  const response = await getOperations(
    authedRequest(`/api/v1/agent-view/holdings/${holdingId}/operations${query}`),
    { params: Promise.resolve({ holdingId }) },
  );
  return { body: await response.json(), response };
}

interface HoldingSummaryRow {
  id: string;
  label: string;
  direction: string;
  instrument: string;
}

/** Resolve a holding's public id by its frozen label via the financial context. */
async function holdingIdByLabel(scopeId: string, label: string): Promise<string> {
  // Reuse the snapshot list endpoint's sibling: read the holding detail is the
  // target under test, so derive the id from the financial-context holdings.
  const body = await (
    await (
      await import("../apps/web/app/api/v1/agent-view/scopes/[scopeId]/financial-context/route")
    ).GET(authedRequest(`/api/v1/agent-view/scopes/${scopeId}/financial-context`), {
      params: Promise.resolve({ scopeId }),
    })
  ).json();
  const items = body.data.holdings.items as HoldingSummaryRow[];
  return items.find((row) => row.label === label)!.id;
}

/**
 * Seed a household with a cash asset, a real-estate home + mortgage, and an
 * investment fund with three operations (two buys, one sell) so the tests can
 * exercise stored holdings, derived (investment) holdings, and operation rows.
 */
function seedPortfolio(): void {
  const databasePath = tempDatabasePath("worthline-agent-view-hold-");
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
  store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: owner,
  });
  store.recordOperationAndRipple(
    {
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-06-01",
      feesMinor: 150,
      id: "op_buy_1",
      kind: "buy",
      pricePerUnit: "1500.00",
      units: "10",
    },
    { today: "2026-06-10" },
  );
  store.recordOperationAndRipple(
    {
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-06-05",
      feesMinor: 50,
      id: "op_sell_1",
      kind: "sell",
      pricePerUnit: "1600.00",
      units: "2",
    },
    { today: "2026-06-10" },
  );
  store.recordOperationAndRipple(
    {
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-06-05",
      feesMinor: 0,
      id: "op_buy_2",
      kind: "buy",
      pricePerUnit: "1550.00",
      units: "3",
    },
    { today: "2026-06-10" },
  );
  store.close();
}

// An API client that dispatches MCP calls to the real route handlers, so MCP
// output is proven against the HTTP contract rather than a hand-written double.
const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = authedRequest(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/agent-view/scopes") {
      return (await (await getScopes(req)).json()) as T;
    }

    const opMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/holdings\/([^/]+)\/operations$/,
    );
    if (opMatch) {
      const holdingId = decodeURIComponent(opMatch[1]!);
      const response = await getOperations(req, {
        params: Promise.resolve({ holdingId }),
      });
      return (await response.json()) as T;
    }

    const holdingMatch = url.pathname.match(/^\/api\/v1\/agent-view\/holdings\/([^/]+)$/);
    if (holdingMatch) {
      const holdingId = decodeURIComponent(holdingMatch[1]!);
      const response = await getHolding(req, {
        params: Promise.resolve({ holdingId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

describe("GET /api/v1/agent-view/holdings/{holdingId}", () => {
  test("returns a stored holding's full detail with ownership and quality summary", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");

    const { body, response } = await holding(cashId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const detail = body.data as {
      id: string;
      object: string;
      label: string;
      direction: string;
      instrument: string;
      valuationMethod: string;
      liquidityTier: string;
      currentValue: { amountMinor: number; currency: string };
      ownership: Array<{ member: { id: string; label: string }; share: string }>;
      qualitySummary: { hasWarnings: boolean };
      operationSummary?: unknown;
      sourceSummary?: unknown;
    };

    expect(detail.id).toBe(cashId);
    expect(detail.id).toMatch(/^wl_hld_/);
    expect(detail.object).toBe("holding");
    expect(detail.label).toBe("Cuenta");
    expect(detail.direction).toBe("asset");
    expect(detail.instrument).toBe("current_account");
    expect(detail.valuationMethod).toBe("stored");
    expect(detail.liquidityTier).toBe("cash");
    // Household projection is unscoped/full value.
    expect(detail.currentValue).toEqual(eur(10_000_00));
    expect(detail.ownership).toEqual([
      {
        member: { id: detail.ownership[0]!.member.id, label: "Jose", object: "member" },
        share: "1",
      },
    ]);
    expect(detail.qualitySummary.hasWarnings).toBe(false);
    // Stored holdings carry no operation summary or source summary.
    expect(detail.operationSummary).toBeUndefined();
    expect(detail.sourceSummary).toBeUndefined();
  });

  test("returns a derived (investment) holding with calculation facts and operation summary", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");

    const { body } = await holding(fundId);
    const detail = body.data as {
      direction: string;
      instrument: string;
      valuationMethod: string;
      liquidityTier: string;
      currentValue: { amountMinor: number };
      operationSummary: {
        operationCount: number;
        unitsBought: string;
        unitsSold: string;
        feesTotal: { amountMinor: number };
      };
    };

    expect(detail.direction).toBe("asset");
    expect(detail.valuationMethod).toBe("derived");
    expect(detail.liquidityTier).toBe("market");
    // 10 bought + 3 bought - 2 sold = 11 units; price was last 1550.00 (the
    // latest operation). currentValue is the household projection's derived value.
    expect(detail.currentValue.amountMinor).toBeGreaterThan(0);
    expect(detail.operationSummary.operationCount).toBe(3);
    expect(detail.operationSummary.unitsBought).toBe("13");
    expect(detail.operationSummary.unitsSold).toBe("2");
    expect(detail.operationSummary.feesTotal).toEqual(eur(200));
  });

  test("returns a liability holding as direction=liability", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const mortgageId = await holdingIdByLabel(scopeId, "Hipoteca");

    const { body } = await holding(mortgageId);
    const detail = body.data as {
      direction: string;
      currentValue: { amountMinor: number };
    };

    expect(detail.direction).toBe("liability");
    expect(detail.currentValue).toEqual(eur(100_000_00));
  });

  test("unknown holding id → 404 not_found", async () => {
    seedPortfolio();
    const { body, response } = await holding("wl_hld_doesnotexist");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("rejects unknown query parameters", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");

    const response = await getHolding(
      authedRequest(`/api/v1/agent-view/holdings/${cashId}?nope=1`),
      { params: Promise.resolve({ holdingId: cashId }) },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
  });

  test("requires the local capability token", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");

    const response = await getHolding(
      new NextRequest(`http://127.0.0.1/api/v1/agent-view/holdings/${cashId}`, {
        method: "GET",
      }),
      { params: Promise.resolve({ holdingId: cashId }) },
    );

    expect(response.status).toBe(401);
  });

  test("MCP get_holding_detail mirrors the HTTP shape", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");
    const httpBody = (await holding(fundId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_holding_detail.invoke({ holdingId: fundId });

    expect(mcpBody).toEqual(httpBody);
  });
});

describe("GET /api/v1/agent-view/holdings/{holdingId}/operations", () => {
  test("returns the investment's operations newest-first with money, units, and fees", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");

    const { body, response } = await operations(fundId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const rows = body.data as Array<{
      id: string;
      object: string;
      date: string;
      kind: string;
      units: string;
      pricePerUnit: string;
      grossAmount: { amountMinor: number; currency: string };
      fees: { amountMinor: number; currency: string };
    }>;

    // Default sort is newest-first: date desc, then public op id desc on a tie.
    expect(rows.map((r) => r.date)).toEqual(["2026-06-05", "2026-06-05", "2026-06-01"]);
    for (const row of rows) {
      expect(row.id).toMatch(/^wl_op_[a-f0-9]{32}$/);
      expect(row.object).toBe("operation");
    }

    const buy1 = rows.find((r) => r.date === "2026-06-01")!;
    expect(buy1.kind).toBe("buy");
    expect(buy1.units).toBe("10");
    expect(buy1.pricePerUnit).toBe("1500.00");
    expect(buy1.grossAmount).toEqual(eur(15_000_00)); // 10 * 1500.00
    expect(buy1.fees).toEqual(eur(150));

    expect(body.meta.limit).toBe(100);
    expect(body.meta.hasNext).toBe(false);
    expect(body.meta.nextCursor).toBeUndefined();
    expect(body.links.self).toBe(`/api/v1/agent-view/holdings/${fundId}/operations`);
  });

  test("sort=date returns operations oldest-first", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");

    const { body } = await operations(fundId, "?sort=date");
    expect((body.data as Array<{ date: string }>).map((r) => r.date)).toEqual([
      "2026-06-01",
      "2026-06-05",
      "2026-06-05",
    ]);
  });

  test("filters by inclusive from/to window", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");

    const { body } = await operations(fundId, "?sort=date&from=2026-06-05&to=2026-06-05");
    expect((body.data as Array<{ date: string }>).map((r) => r.date)).toEqual([
      "2026-06-05",
      "2026-06-05",
    ]);
  });

  test("paginates with stable cursors, walking every operation exactly once", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");

    const first = await operations(fundId, "?sort=date&limit=2");
    const seen: string[] = (first.body.data as Array<{ id: string }>).map((r) => r.id);
    expect(seen).toHaveLength(2);
    expect(first.body.meta.hasNext).toBe(true);
    expect(first.body.links.next).toContain(
      `cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );

    let cursor: string | undefined = first.body.meta.nextCursor;
    let guard = 0;
    while (cursor && guard++ < 10) {
      const page = await operations(
        fundId,
        `?sort=date&limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      seen.push(...(page.body.data as Array<{ id: string }>).map((r) => r.id));
      cursor = page.body.meta.hasNext ? page.body.meta.nextCursor : undefined;
    }

    // Every operation walked once, none repeated.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  test("clamps limit over the documented maximum to 500", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");

    const { body } = await operations(fundId, "?limit=9999");
    expect(body.meta.limit).toBe(500);
  });

  test("non-investment holding → 422 unprocessable_entity", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");
    const mortgageId = await holdingIdByLabel(scopeId, "Hipoteca");

    const cash = await operations(cashId);
    expect(cash.response.status).toBe(422);
    expect(cash.body.error.code).toBe("unprocessable_entity");

    const mortgage = await operations(mortgageId);
    expect(mortgage.response.status).toBe(422);
    expect(mortgage.body.error.code).toBe("unprocessable_entity");
  });

  test("unknown holding id → 404 not_found", async () => {
    seedPortfolio();
    const { body, response } = await operations("wl_hld_doesnotexist");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("maps malformed requests to documented API errors", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");

    const badRequests = [
      "?nope=1", // unknown query parameter
      "?sort=value", // invalid enum
      "?from=2026-13-40", // non-existent calendar date
      "?to=yesterday", // malformed date
      "?limit=0", // below minimum
      "?limit=abc", // non-integer
      "?cursor=not-a-real-cursor", // undecodable cursor
    ];
    for (const query of badRequests) {
      const { response, body } = await operations(fundId, query);
      expect(response.status, `expected 400 for ${query}`).toBe(400);
      expect(body.error.code).toBe("bad_request");
    }
  });

  test("MCP get_operations mirrors the HTTP shape", async () => {
    seedPortfolio();
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");
    const query = "?sort=date&limit=2";
    const httpBody = (await operations(fundId, query)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_operations.invoke({
      holdingId: fundId,
      limit: 2,
      sort: "date",
    });

    expect(mcpBody).toEqual(httpBody);
  });

  test("reads do not mutate persisted state", async () => {
    seedPortfolio();
    const databasePath = process.env.WORTHLINE_DB_PATH as string;
    const scopeId = await householdScopeId();
    const fundId = await holdingIdByLabel(scopeId, "Fondo indexado");
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");

    const before = fingerprint(databasePath);
    await holding(fundId);
    await holding(cashId);
    await operations(fundId);
    await operations(fundId, "?sort=date&limit=1");
    const after = fingerprint(databasePath);

    expect(after).toBe(before);
  });
});

// A fingerprint of every mutation-prone read, to prove an agent read writes
// nothing (no operations rewritten, no price cache, no public IDs, no holdings).
function fingerprint(databasePath: string): string {
  const store = createWorthlineStore({ databasePath });
  const snapshot = JSON.stringify({
    assets: store.assets.readAssets(),
    liabilities: store.liabilities.readLiabilities(),
    operations: store.operations.readOperations("asset_fund"),
    priceCache: store.operations.readAllPriceCacheEntries(),
    publicIds: store.agentView.readPublicIds(),
  });
  store.close();
  return snapshot;
}
