import { GET as getContributionPlan } from "@web/api/v1/agent-view/scopes/[scopeId]/contribution-plan/route";
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

function scopesRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1/api/v1/agent-view/scopes", {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

function contributionPlanRequest(scopeId: string, query = ""): NextRequest {
  return new NextRequest(
    `http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/contribution-plan${query}`,
    {
      headers: { authorization: "Bearer local-agent-token" },
      method: "GET",
    },
  );
}

async function householdScopeId(): Promise<string> {
  const body = await (await getScopes(scopesRequest())).json();
  const scopes = body.data as { id: string; type: string }[];
  return scopes.find((scope) => scope.type === "household")!.id;
}

describe("GET /api/v1/agent-view/scopes/{scopeId}/contribution-plan", () => {
  test("returns forecast-labelled plan, allocation, reconciliation, and what-if", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-contrib-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 50_000_00,
      id: "asset_fund",
      instrument: "fund",
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "investment",
    });
    await store.operations.upsertPrice({
      assetId: "asset_fund",
      currency: "EUR",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      freshnessState: "fresh",
      price: "100",
      source: "manual",
    });
    await store.contributionPlan.createPlannedContribution({
      scopeId: "household",
      destinationHoldingId: "asset_fund",
      amount: { mode: "money", value: 300_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    });
    await store.saveFireConfig("household", {
      monthlySpendingMinor: 2_000_00,
      monthlySavingsCapacityMinor: 100_00,
      expectedRealReturn: 0.05,
      currentAge: 35,
    });
    store.close();

    const scopeId = await householdScopeId();
    const response = await getContributionPlan(
      contributionPlanRequest(scopeId, "?month=2026-07&growthAssumption=flat"),
      { params: Promise.resolve({ scopeId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.object).toBe("contribution_plan_context");
    expect(body.data.forecast).toBe(true);
    expect(body.data.truthNote).toContain("Forecast metadata only");
    expect(body.data.status).toBe("configured");
    expect(body.data.contributions).toHaveLength(1);
    expect(body.data.contributions[0].amount.mode).toBe("money");
    expect(body.data.monthlyAllocation.month).toBe("2026-07");
    expect(body.data.monthlyAllocation.totalPlanned.amountMinor).toBe(300_00);
    expect(body.data.monthlyAllocation.slices).toHaveLength(1);
    expect(body.data.monthlySavingsCapacity.source).toBe("plan_derived");
    expect(body.data.reconciliation.object).toBe("contribution_reconciliation");
    expect(body.data.whatIf.growthAssumption).toBe("flat");
    expect(body.data.whatIf.status).toBe("configured");
    expect(body.data.whatIf.scenarios).toHaveLength(3);
  });

  test("an empty plan still labels the response as forecast-only", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-contrib-empty-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.close();

    const scopeId = await householdScopeId();
    const response = await getContributionPlan(contributionPlanRequest(scopeId), {
      params: Promise.resolve({ scopeId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.forecast).toBe(true);
    expect(body.data.status).toBe("empty");
    expect(body.data.contributions).toEqual([]);
    expect(body.data.whatIf.status).toBe("unconfigured");
  });
});
