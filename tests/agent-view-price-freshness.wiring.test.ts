import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getPriceFreshness } from "@web/api/v1/agent-view/holdings/[holdingId]/price-freshness/route";
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

async function priceFreshness(holdingId: string) {
  const response = await getPriceFreshness(
    authedRequest(`/api/v1/agent-view/holdings/${holdingId}/price-freshness`),
    { params: Promise.resolve({ holdingId }) },
  );
  return { body: await response.json(), response };
}

interface HoldingSummaryRow {
  id: string;
  label: string;
}

/** Resolve a holding's public id by its frozen label via the financial context. */
async function holdingIdByLabel(label: string): Promise<string> {
  const scopesBody = await (
    await getScopes(authedRequest("/api/v1/agent-view/scopes"))
  ).json();
  const scopeId = (scopesBody.data as Array<{ id: string; type: string }>).find(
    (scope) => scope.type === "household",
  )!.id;
  const body = await (
    await (
      await import("@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route")
    ).GET(authedRequest(`/api/v1/agent-view/scopes/${scopeId}/financial-context`), {
      params: Promise.resolve({ scopeId }),
    })
  ).json();
  const items = body.data.holdings.items as HoldingSummaryRow[];
  return items.find((row) => row.label === label)!.id;
}

/**
 * Seed a household with a provider-priced (stale) holding and a manual holding
 * that has no cached quote, so the tests can exercise both the freshness and the
 * documented null-freshness branches.
 */
async function seedPortfolio(): Promise<void> {
  const databasePath = tempDatabasePath("worthline-agent-view-freshness-");
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
    currentValueMinor: 5_000_00,
    id: "asset_priced",
    liquidityTier: "market",
    name: "Fondo viejo",
    ownership: owner,
    type: "manual",
  });
  await store.operations.upsertPrice({
    assetId: "asset_priced",
    currency: "EUR",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    freshnessState: "stale",
    price: "123.45",
    source: "yahoo",
    staleReason: "Precio caducado",
  });
  store.close();
}

describe("GET /api/v1/agent-view/holdings/{holdingId}/price-freshness", () => {
  test("resolves a holding to its cached-price freshness with source and fetch time", async () => {
    await seedPortfolio();
    const pricedId = await holdingIdByLabel("Fondo viejo");

    const { body, response } = await priceFreshness(pricedId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(body.data).toEqual({
      object: "price_freshness",
      holding: pricedId,
      freshness: {
        freshnessState: "stale",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        source: "yahoo",
        staleReason: "Precio caducado",
      },
    });
  });

  test("returns freshness:null for a holding with no provider quote", async () => {
    await seedPortfolio();
    const cashId = await holdingIdByLabel("Cuenta");

    const { body, response } = await priceFreshness(cashId);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      object: "price_freshness",
      holding: cashId,
      freshness: null,
    });
  });

  test("never leaks the price figure or a provider payload", async () => {
    await seedPortfolio();
    const pricedId = await holdingIdByLabel("Fondo viejo");

    const { body } = await priceFreshness(pricedId);
    const serialized = JSON.stringify(body);

    // The seeded cached price is 123.45 — it must never ride the freshness reply,
    // and no `price`/`priceDate` cache field may surface (the `price_freshness`
    // object tag is fine — it carries no figure).
    expect(serialized).not.toContain("123.45");
    expect(serialized).not.toContain('"price":');
    expect(serialized).not.toContain('"priceDate":');
  });

  test("unknown holding id → 404 not_found", async () => {
    await seedPortfolio();
    const { body, response } = await priceFreshness("wl_hld_doesnotexist");

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("rejects unknown query parameters", async () => {
    await seedPortfolio();
    const pricedId = await holdingIdByLabel("Fondo viejo");

    const response = await getPriceFreshness(
      authedRequest(`/api/v1/agent-view/holdings/${pricedId}/price-freshness?nope=1`),
      { params: Promise.resolve({ holdingId: pricedId }) },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
  });

  test("requires the local capability token", async () => {
    await seedPortfolio();
    const pricedId = await holdingIdByLabel("Fondo viejo");

    const response = await getPriceFreshness(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/holdings/${pricedId}/price-freshness`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ holdingId: pricedId }) },
    );

    expect(response.status).toBe(401);
  });

  test("MCP get_price_freshness mirrors the HTTP shape", async () => {
    await seedPortfolio();
    const pricedId = await holdingIdByLabel("Fondo viejo");
    const httpBody = (await priceFreshness(pricedId)).body;

    const client: AgentViewApiClient = {
      get: async <T>(path: string): Promise<T> => {
        const match = path.match(
          /^\/api\/v1\/agent-view\/holdings\/([^/]+)\/price-freshness$/,
        );
        if (!match) throw new Error(`Unrouted agent-view path: ${path}`);
        const holdingId = decodeURIComponent(match[1]!);
        const response = await getPriceFreshness(authedRequest(path), {
          params: Promise.resolve({ holdingId }),
        });
        return (await response.json()) as T;
      },
    };

    const catalog = createAgentViewMcpToolCatalog(client);
    const mcpBody = await catalog.get_price_freshness.invoke({ holdingId: pricedId });

    expect(mcpBody).toEqual(httpBody);
  });
});
