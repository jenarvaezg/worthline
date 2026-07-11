import { derivePublicId } from "@web/agent-view/derived-id";
import { GET as getContributionPlan } from "@web/api/v1/agent-view/scopes/[scopeId]/contribution-plan/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStore } from "@worthline/db";
import { contributionOccurrenceId } from "@worthline/domain";
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
    expect(body.data.contributions[0].active).toBe(true);
    expect(body.data.monthlyAllocation.month).toBe("2026-07");
    expect(body.data.monthlyAllocation.totalPlanned.amountMinor).toBe(300_00);
    expect(body.data.monthlyAllocation.totalExecuted.amountMinor).toBe(0);
    expect(body.data.monthlyAllocation.missingUnitPriceHoldings).toEqual([]);
    expect(body.data.monthlyAllocation.slices).toHaveLength(1);
    expect(body.data.monthlyAllocation.slices[0].shareOfMonth).toBe("1");
    expect(body.data.reconciliation.window.from).toBe("2026-01-01");
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

  test("flags unpriced units and shows a linked buy as executed truth", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-contrib-linked-");
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
    await store.assets.createInvestmentAsset({
      currency: "EUR",
      id: "asset_etf",
      liquidityTier: "market",
      name: "ETF sin precio",
      ownership: owner,
    });
    await store.recordOperationAndRipple(
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
    const fund = await store.contributionPlan.createPlannedContribution({
      scopeId: "household",
      destinationHoldingId: "asset_fund",
      amount: { mode: "money", value: 500_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    });
    await store.contributionPlan.createPlannedContribution({
      scopeId: "household",
      destinationHoldingId: "asset_etf",
      amount: { mode: "units", value: "1" },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    });
    await store.contributionPlan.linkOperation({
      contributionId: fund.id,
      occurrenceId: contributionOccurrenceId(fund.id, "2026-06-01"),
      operationId: "op_buy_1",
    });
    const etfPublicId = (await store.agentView.readPublicIds()).find(
      (row) => row.entityType === "holding" && row.entityId === "asset_etf",
    )!.publicId;
    store.close();

    const scopeId = await householdScopeId();
    const response = await getContributionPlan(
      contributionPlanRequest(scopeId, "?month=2026-06"),
      { params: Promise.resolve({ scopeId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);

    // Unpriced units destination: reported with its planned units, never a
    // guessed figure, and excluded from the priced total.
    expect(body.data.monthlyAllocation.missingUnitPriceHoldings).toEqual([etfPublicId]);
    expect(body.data.monthlyAllocation.totalPlanned.amountMinor).toBe(500_00);
    const unpricedSlice = body.data.monthlyAllocation.slices.find(
      (slice: { destinationHolding: string }) => slice.destinationHolding === etfPublicId,
    );
    expect(unpricedSlice.plannedAmount).toBeNull();
    expect(unpricedSlice.plannedUnits).toBe("1");
    expect(unpricedSlice.shareOfMonth).toBe("0");

    // The linked buy shows as executed contrast in the month's allocation…
    expect(body.data.monthlyAllocation.totalExecuted.amountMinor).toBe(1_500_150);

    // …and as a partial, backlogged occurrence carrying the same wl_op_… id
    // get_operations returns.
    const linked = body.data.reconciliation.pending.find(
      (item: { plannedDate: string; destinationHolding: string }) =>
        item.plannedDate === "2026-06-01" && item.destinationHolding !== etfPublicId,
    );
    expect(linked).toMatchObject({
      state: "partial",
      backlog: true,
      linkedOperations: [derivePublicId("op", "op_buy_1")],
      progress: {
        mode: "money",
        planned: { amountMinor: 500_00, currency: "EUR" },
        executed: { amountMinor: 1_500_150, currency: "EUR" },
        delta: { amountMinor: 1_450_150, currency: "EUR" },
      },
    });
  });

  test("keeps the plan facets and reports the what-if unconfigured without a FIRE config", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-contrib-nofire-");
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
    await store.contributionPlan.createPlannedContribution({
      scopeId: "household",
      destinationHoldingId: "asset_fund",
      amount: { mode: "money", value: 300_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    });
    store.close();

    const scopeId = await householdScopeId();
    const response = await getContributionPlan(
      contributionPlanRequest(scopeId, "?month=2026-07"),
      { params: Promise.resolve({ scopeId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("configured");
    expect(body.data.monthlyAllocation.totalPlanned.amountMinor).toBe(300_00);
    expect(body.data.whatIf.status).toBe("unconfigured");
    expect(body.data.whatIf.scenarios).toEqual([]);
  });

  test("rejects a malformed month with a 400", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-contrib-badmonth-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.close();

    const scopeId = await householdScopeId();
    const response = await getContributionPlan(
      contributionPlanRequest(scopeId, "?month=julio"),
      { params: Promise.resolve({ scopeId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details).toEqual({ month: "julio" });
  });

  test("rejects an unknown growthAssumption with a 400", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-contrib-badgrowth-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStore({ databasePath });
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jose", name: "Jose" }],
      mode: "individual",
    });
    store.close();

    const scopeId = await householdScopeId();
    const response = await getContributionPlan(
      contributionPlanRequest(scopeId, "?growthAssumption=turbo"),
      { params: Promise.resolve({ scopeId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("bad_request");
  });

  test("reading the contribution plan writes nothing", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-contrib-pure-");
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
    await store.contributionPlan.createPlannedContribution({
      scopeId: "household",
      destinationHoldingId: "asset_fund",
      amount: { mode: "money", value: 300_00 },
      cadence: { kind: "monthly", dayOfMonth: 1 },
      startDate: "2026-01-01",
    });
    store.close();

    const fingerprint = async (): Promise<string> => {
      const check = await createWorthlineStore({ databasePath });
      const snapshot = JSON.stringify({
        plan: await check.contributionPlan.readContributionPlan("household"),
        publicIds: await check.agentView.readPublicIds(),
        reconciliations: await check.contributionPlan.readReconciliations("household"),
      });
      check.close();
      return snapshot;
    };

    const scopeId = await householdScopeId();
    const before = await fingerprint();
    await getContributionPlan(contributionPlanRequest(scopeId), {
      params: Promise.resolve({ scopeId }),
    });
    await getContributionPlan(
      contributionPlanRequest(scopeId, "?growthAssumption=flat"),
      { params: Promise.resolve({ scopeId }) },
    );
    expect(await fingerprint()).toBe(before);
  });
});
