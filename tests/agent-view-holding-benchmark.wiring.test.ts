import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getHolding } from "@web/api/v1/agent-view/holdings/[holdingId]/route";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createControlPlaneStore, createWorthlineStore } from "@worthline/db";
import type { ExposureProfile } from "@worthline/domain";
import { captureValuedNetWorthSnapshot } from "@worthline/domain";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";
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

function authedRequest(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1${path}`, {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

interface ScopeRef {
  id: string;
  type: string;
}

async function householdScopeId(): Promise<string> {
  const body = await (await getScopes(authedRequest("/api/v1/agent-view/scopes"))).json();
  const scopes = body.data as ScopeRef[];
  return scopes.find((scope) => scope.type === "household")!.id;
}

async function holding(holdingId: string) {
  const response = await getHolding(
    authedRequest(`/api/v1/agent-view/holdings/${holdingId}`),
    { params: Promise.resolve({ holdingId }) },
  );
  return { body: await response.json(), response };
}

interface HoldingSummaryRow {
  id: string;
  label: string;
}

async function holdingIdByLabel(scopeId: string, label: string): Promise<string> {
  const response = await getFinancialContext(
    authedRequest(`/api/v1/agent-view/scopes/${scopeId}/financial-context`),
    { params: Promise.resolve({ scopeId }) },
  );
  const body = await response.json();
  const items = body.data.holdings.items as HoldingSummaryRow[];
  return items.find((row) => row.label === label)!.id;
}

const MSCI_ISIN = "IE00B4L5Y983";
const MSCI_PROFILE: ExposureProfile = {
  breakdowns: { assetClass: { equity: "1" } },
  hedged: false,
  key: MSCI_ISIN,
  ter: "0.002",
  trackedIndex: "MSCI World",
};

async function seedBenchmarkHolding(controlPlanePath: string): Promise<void> {
  const databasePath = tempDatabasePath("worthline-agent-view-hold-bench-");
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";
  process.env.WORTHLINE_CONTROL_PLANE_DB_URL = `file:${controlPlanePath}`;

  const store = await createWorthlineStore({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  const owner = [{ memberId: "member_jose", shareBps: 10_000 }];
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_msci",
    instrument: "etf",
    isin: MSCI_ISIN,
    liquidityTier: "market",
    name: "MSCI World ETF",
    ownership: owner,
    providerSymbol: "IWDA.AS",
  });
  await store.command.recordInvestmentOperation(
    {
      assetId: "asset_msci",
      currency: "EUR",
      executedAt: "2024-01-15",
      feesMinor: 0,
      id: "op_open",
      kind: "buy",
      pricePerUnit: "100",
      units: "1000",
    },
    { today: "2024-03-31" },
  );
  await store.assets.updateInvestmentAsset({
    id: "asset_msci",
    isin: MSCI_ISIN,
    manualPricePerUnit: "100",
    name: "MSCI World ETF",
    providerSymbol: "IWDA.AS",
  });
  await store.exposureProfiles.saveExposureProfile(MSCI_PROFILE);

  const workspace = (await store.workspace.readWorkspace())!;
  const assetsJan = await store.assets.readAssets();
  const liabilities = await store.liabilities.readLiabilities();
  const janCapture = captureValuedNetWorthSnapshot({
    assets: assetsJan,
    capturedAt: "2024-01-31T20:00:00.000Z",
    id: "snap_2024_01_31",
    liabilities,
    scopeId: "household",
    scopeLabel: "Hogar",
    workspace,
  });
  await store.snapshots.saveSnapshot(janCapture);

  await store.assets.updateInvestmentAsset({
    id: "asset_msci",
    isin: MSCI_ISIN,
    manualPricePerUnit: "130",
    name: "MSCI World ETF",
    providerSymbol: "IWDA.AS",
  });
  const marCapture = captureValuedNetWorthSnapshot({
    assets: await store.assets.readAssets(),
    capturedAt: "2024-03-31T20:00:00.000Z",
    id: "snap_2024_03_31",
    liabilities,
    scopeId: "household",
    scopeLabel: "Hogar",
    workspace,
  });
  await store.snapshots.saveSnapshot(marCapture);
  store.close();

  const controlPlane = await createControlPlaneStore({ url: `file:${controlPlanePath}` });
  await controlPlane.upsertBenchmarkPrices("msci-world-tr", [
    { dateKey: "2024-01-01", value: "100" },
    { dateKey: "2024-03-01", value: "110" },
  ]);
  controlPlane.close();
}

const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = authedRequest(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/agent-view/scopes") {
      return (await (await getScopes(req)).json()) as T;
    }

    const holdingMatch = url.pathname.match(/^\/api\/v1\/agent-view\/holdings\/([^/]+)$/);
    if (holdingMatch) {
      const holdingId = decodeURIComponent(holdingMatch[1]!);
      return (await (
        await getHolding(req, { params: Promise.resolve({ holdingId }) })
      ).json()) as T;
    }

    const contextMatch = url.pathname.match(
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/financial-context$/,
    );
    if (contextMatch) {
      const scopeId = decodeURIComponent(contextMatch[1]!);
      return (await (
        await getFinancialContext(req, { params: Promise.resolve({ scopeId }) })
      ).json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

describe("get_holding_detail — vsBenchmark (#626)", () => {
  test("returns TWR vs tracked index when the series is mapped and cached", async () => {
    const controlPlanePath = tempDatabasePath("worthline-control-plane-bench-");
    await seedBenchmarkHolding(controlPlanePath);

    const scopeId = await householdScopeId();
    const holdingId = await holdingIdByLabel(scopeId, "MSCI World ETF");
    const { body, response } = await holding(holdingId);

    expect(response.status).toBe(200);
    expect(body.data.exposureProfile?.trackedIndex).toBe("MSCI World");
    expect(body.data.vsBenchmark).toEqual({
      comparison: {
        coverageNote: expect.stringContaining("EUNL"),
        excessGrowth: expect.closeTo(0.18181818181818182),
        holdingTwr: expect.closeTo(0.3),
        indexGrowth: expect.closeTo(0.1),
        seriesId: "msci-world-tr",
        sinceDate: "2024-01-31",
        trackedIndex: "MSCI World",
        untilDate: "2024-03-31",
        variant: "total_return",
      },
      unavailableReason: null,
    });
  });

  test("MCP get_holding_detail mirrors the HTTP vsBenchmark block", async () => {
    const controlPlanePath = tempDatabasePath("worthline-control-plane-bench-mcp-");
    await seedBenchmarkHolding(controlPlanePath);

    const scopeId = await householdScopeId();
    const holdingId = await holdingIdByLabel(scopeId, "MSCI World ETF");
    const httpBody = (await holding(holdingId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_holding_detail.invoke({ holdingId });

    expect(mcpBody).toEqual(httpBody);
  });

  test("honestly signals no_tracked_index when the exposure profile has no index", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-hold-bench-none-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_plain",
      instrument: "fund",
      liquidityTier: "market",
      name: "Fondo sin índice",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    });
    store.close();

    const scopeId = await householdScopeId();
    const holdingId = await holdingIdByLabel(scopeId, "Fondo sin índice");
    const { body } = await holding(holdingId);

    expect(body.data.vsBenchmark).toEqual({
      comparison: null,
      unavailableReason: "no_tracked_index",
    });
  });
});
