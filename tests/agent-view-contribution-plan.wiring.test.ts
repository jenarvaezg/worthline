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

function request(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1${path}`, {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

async function householdScopeId(): Promise<string> {
  const body = await (await getScopes(request("/api/v1/agent-view/scopes"))).json();
  return (body.data as Array<{ id: string; type: string }>).find(
    (scope) => scope.type === "household",
  )!.id;
}

async function contributionPlan(scopeId: string, query = "") {
  const path = `/api/v1/agent-view/scopes/${scopeId}/contribution-plan${query}`;
  const response = await getContributionPlan(request(path), {
    params: Promise.resolve({ scopeId }),
  });
  return { body: await response.json(), response };
}

interface SeededPlan {
  databasePath: string;
  fundContributionId: string;
  etfContributionId: string;
}

// Seed a household with two investment destinations: a fund receiving 500 €/mo
// (money) with one linked buy, and an ETF receiving 1 unit/mo with no cached
// price (the honest "incomplete" allocation path). Plan rows start in the past
// so the pending list carries a visible backlog.
async function seedPlan(options: { fireConfig: boolean }): Promise<SeededPlan> {
  const databasePath = tempDatabasePath("worthline-agent-view-contribution-plan-");
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
    name: "ETF",
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
    amount: { mode: "money", value: 50_000 },
    cadence: { kind: "monthly", dayOfMonth: 1 },
    destinationHoldingId: "asset_fund",
    scopeId: "household",
    startDate: "2026-01-01",
  });
  const etf = await store.contributionPlan.createPlannedContribution({
    amount: { mode: "units", value: "1" },
    cadence: { kind: "monthly", dayOfMonth: 1 },
    destinationHoldingId: "asset_etf",
    scopeId: "household",
    startDate: "2026-01-01",
  });
  await store.contributionPlan.linkOperation({
    contributionId: fund.id,
    occurrenceId: contributionOccurrenceId(fund.id, "2026-06-01"),
    operationId: "op_buy_1",
  });

  if (options.fireConfig) {
    await store.saveFireConfig("household", {
      currentAge: 30,
      expectedRealReturn: 0.05,
      monthlySpendingMinor: 2_000_00,
      safeWithdrawalRate: 0.04,
    });
  }

  store.close();
  return { databasePath, etfContributionId: etf.id, fundContributionId: fund.id };
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

describe("GET /api/v1/agent-view/scopes/{scopeId}/contribution-plan", () => {
  test("returns the plan rows, monthly allocation, pending backlog, and what-if", async () => {
    const seeded = await seedPlan({ fireConfig: true });
    const scopeId = await householdScopeId();
    const fundHolding = await holdingPublicId(seeded.databasePath, "asset_fund");
    const etfHolding = await holdingPublicId(seeded.databasePath, "asset_etf");

    const { body, response } = await contributionPlan(scopeId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.object).toBe("contribution_plan");
    // In-band forecast marker — unambiguous even without the tool description.
    expect(body.data.basis).toBe("forecast");
    expect(body.data.scope.id).toBe(scopeId);
    expect(body.data.status).toBe("configured");

    // Plan rows: opaque derived ids, public destination ids, forecast metadata.
    const fundRow = body.data.contributions.find(
      (row: { destinationHolding: string }) => row.destinationHolding === fundHolding,
    );
    expect(fundRow).toEqual({
      active: true,
      amount: { mode: "money", money: { amountMinor: 50_000, currency: "EUR" } },
      cadence: { dayOfMonth: 1, kind: "monthly" },
      destinationHolding: fundHolding,
      id: derivePublicId("pcn", seeded.fundContributionId),
      object: "planned_contribution",
      startDate: "2026-01-01",
    });
    const etfRow = body.data.contributions.find(
      (row: { destinationHolding: string }) => row.destinationHolding === etfHolding,
    );
    expect(etfRow.amount).toEqual({ mode: "units", units: "1" });

    // Monthly allocation: the priced fund line leads; the unpriced ETF line is
    // flagged incomplete at zero — a lower bound, never an invented figure.
    expect(body.data.monthlyAllocation).toEqual({
      lines: [
        {
          destinationHolding: fundHolding,
          incomplete: false,
          monthly: { amountMinor: 50_000, currency: "EUR" },
        },
        {
          destinationHolding: etfHolding,
          incomplete: true,
          monthly: { amountMinor: 0, currency: "EUR" },
        },
      ],
      missingUnitPriceHoldings: [etfHolding],
      total: { amountMinor: 50_000, currency: "EUR" },
    });

    // Pending occurrences: unconfirmed only, past ones flagged as backlog.
    expect(body.data.pendingWindow.from).toBe("2026-01-01");
    expect(body.data.pending.length).toBeGreaterThan(0);
    for (const item of body.data.pending) {
      expect(["pending", "partial"]).toContain(item.state);
      expect(item.object).toBe("contribution_occurrence");
    }

    // The occurrence with a linked buy is partial with the executed truth
    // echoed via the same wl_op_… id get_operations returns.
    const linked = body.data.pending.find(
      (item: { plannedDate: string; contribution: string }) =>
        item.plannedDate === "2026-06-01" &&
        item.contribution === derivePublicId("pcn", seeded.fundContributionId),
    );
    expect(linked).toMatchObject({
      backlog: true,
      destinationHolding: fundHolding,
      operations: [derivePublicId("op", "op_buy_1")],
      progress: {
        delta: { amountMinor: 1_450_150, currency: "EUR" },
        executed: { amountMinor: 1_500_150, currency: "EUR" },
        mode: "money",
        planned: { amountMinor: 50_000, currency: "EUR" },
      },
      state: "partial",
    });

    // What-if: three scenarios under the default historical toggle; the ETF has
    // no cached price, so growth falls back to the assumed rate.
    expect(body.data.whatIf.status).toBe("configured");
    expect(body.data.whatIf.growthAssumption).toBe("historical");
    expect(body.data.whatIf.assumedAnnualReturn).toBe("0.05");
    expect(body.data.whatIf.fireNumber).toEqual({
      amountMinor: 600_000_00,
      currency: "EUR",
    });
    expect(
      body.data.whatIf.scenarios.map((scenario: { label: string }) => scenario.label),
    ).toEqual(["optimistic", "base", "pessimistic"]);
  });

  test("the flat toggle projects contributions with zero appreciation", async () => {
    await seedPlan({ fireConfig: true });
    const scopeId = await householdScopeId();

    const { body, response } = await contributionPlan(scopeId, "?growthAssumption=flat");

    expect(response.status).toBe(200);
    expect(body.data.whatIf.growthAssumption).toBe("flat");
    expect(
      body.data.whatIf.scenarios.map(
        (scenario: { annualReturn: string }) => scenario.annualReturn,
      ),
    ).toEqual(["0", "0", "0"]);
  });

  test("rejects an unknown growthAssumption with a 400", async () => {
    await seedPlan({ fireConfig: true });
    const scopeId = await householdScopeId();

    const { body, response } = await contributionPlan(scopeId, "?growthAssumption=turbo");

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("bad_request");
  });

  test("keeps the plan facets and reports the what-if unconfigured without a FIRE config", async () => {
    await seedPlan({ fireConfig: false });
    const scopeId = await householdScopeId();

    const { body, response } = await contributionPlan(scopeId);

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("configured");
    expect(body.data.monthlyAllocation.total.amountMinor).toBe(50_000);
    expect(body.data.whatIf).toEqual({
      growthAssumption: "historical",
      scenarios: [],
      status: "unconfigured",
    });
  });

  test("reading the contribution plan writes nothing", async () => {
    const seeded = await seedPlan({ fireConfig: true });
    const scopeId = await householdScopeId();

    const fingerprint = async (): Promise<string> => {
      const store = await createWorthlineStore({
        databasePath: seeded.databasePath,
      });
      const snapshot = JSON.stringify({
        plan: await store.contributionPlan.readContributionPlan("household"),
        publicIds: await store.agentView.readPublicIds(),
        reconciliations: await store.contributionPlan.readReconciliations("household"),
      });
      store.close();
      return snapshot;
    };

    const before = await fingerprint();
    await contributionPlan(scopeId);
    await contributionPlan(scopeId, "?growthAssumption=flat");
    expect(await fingerprint()).toBe(before);
  });
});
