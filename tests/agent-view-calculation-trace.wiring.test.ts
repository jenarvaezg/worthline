import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getTrace } from "@web/api/v1/agent-view/holdings/[holdingId]/calculation-trace/route";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";
import { captureValuedNetWorthSnapshot } from "@worthline/domain";
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

async function householdScopeId(): Promise<string> {
  const body = await (await getScopes(authedRequest("/api/v1/agent-view/scopes"))).json();
  return (body.data as Array<{ id: string; type: string }>).find(
    (scope) => scope.type === "household",
  )!.id;
}

async function holdingIdByLabel(scopeId: string, label: string): Promise<string> {
  const body = await (
    await getFinancialContext(
      authedRequest(`/api/v1/agent-view/scopes/${scopeId}/financial-context`),
      { params: Promise.resolve({ scopeId }) },
    )
  ).json();
  const items = body.data.holdings.items as Array<{ id: string; label: string }>;
  return items.find((row) => row.label === label)!.id;
}

async function trace(holdingId: string, query = "") {
  const response = await getTrace(
    authedRequest(`/api/v1/agent-view/holdings/${holdingId}/calculation-trace${query}`),
    { params: Promise.resolve({ holdingId }) },
  );
  return { body: await response.json(), response };
}

const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

async function freshStore(prefix: string) {
  const databasePath = tempDatabasePath(prefix);
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStoreUnsafe({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

/** Seed a 120.000 €, 3 %, 240-month amortizable loan disbursed 2020-01-01. */
async function seedLoan(
  store: Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>,
): Promise<void> {
  await store.liabilities.createLiability({
    balanceMinor: 120_000_00,
    currency: "EUR",
    id: "loan",
    name: "Préstamo",
    ownership: owner,
    type: "debt",
  });
  await store.liabilities.setDebtModel("loan", "amortizable");
  await store.liabilities.createAmortizationPlan({
    annualInterestRate: "0.03",
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
    id: "plan_loan",
    initialCapitalMinor: 120_000_00,
    liabilityId: "loan",
    termMonths: 240,
  });
}

/** Capture and persist a household snapshot with the curve-valued ledger at `date`. */
async function captureAt(
  store: Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>,
  date: string,
  id: string,
): Promise<void> {
  const workspace = (await store.workspace.readWorkspace())!;
  const { assets, liabilities } =
    await store.snapshots.readCurveValuedHoldingsAtDate(date);
  const valued = captureValuedNetWorthSnapshot({
    assets,
    capturedAt: `${date}T12:00:00.000Z`,
    id,
    liabilities,
    scopeId: "household",
    scopeLabel: "Hogar",
    workspace,
  });
  await store.snapshots.saveSnapshot({
    holdings: valued.holdings,
    snapshot: valued.snapshot,
  });
}

const routeClient: AgentViewApiClient = {
  get: async <T>(path: string): Promise<T> => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = authedRequest(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/agent-view/scopes") {
      return (await (await getScopes(req)).json()) as T;
    }
    const match = url.pathname.match(
      /^\/api\/v1\/agent-view\/holdings\/([^/]+)\/calculation-trace$/,
    );
    if (match) {
      const holdingId = decodeURIComponent(match[1]!);
      const response = await getTrace(req, {
        params: Promise.resolve({ holdingId }),
      });
      return (await response.json()) as T;
    }
    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

interface TraceBody {
  object: string;
  model: string;
  direction: string;
  currentValue: { amountMinor: number; currency: string };
  schedule?: {
    initialCapital: { amountMinor: number };
    termMonths: number;
    effectiveFrom: string;
    frontiers: Array<{
      index: number;
      date: string;
      openingBalance: { amountMinor: number };
      interest: { amountMinor: number };
      principal: { amountMinor: number };
      closingBalance: { amountMinor: number };
      annualInterestRate: string;
      events: Array<{
        kind: string;
        date: string;
        amount?: { amountMinor: number };
        mode?: string;
      }>;
    }>;
  };
  balanceAnchors?: { interpolation: string; anchors: unknown[] };
  reconciliation: Array<{
    date: string;
    live: { amountMinor: number };
    persisted: { amountMinor: number } | null;
    difference: { amountMinor: number } | null;
    diverges: boolean;
    isSnapshot: boolean;
  }>;
  fidelity: { faithful: boolean; checkedPoints: number; divergences: unknown[] };
  tolerance: {
    band: { amountMinor: number };
    referenceBalance: { amountMinor: number };
    declared?: {
      balance: { amountMinor: number };
      date: string;
      residual: { amountMinor: number };
      withinTolerance: boolean;
    };
  };
}

describe("GET /api/v1/agent-view/holdings/{holdingId}/calculation-trace", () => {
  test("returns the amortization cuadro with the interest/principal split per cuota", async () => {
    const store = await freshStore("worthline-agent-view-trace-");
    await seedLoan(store);
    store.close();

    const holdingId = await holdingIdByLabel(await householdScopeId(), "Préstamo");
    const { body, response } = await trace(holdingId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const data = body.data as TraceBody;
    expect(data.object).toBe("calculation_trace");
    expect(data.model).toBe("amortizable");
    expect(data.direction).toBe("liability");
    expect(data.schedule!.initialCapital.amountMinor).toBe(120_000_00);
    expect(data.schedule!.termMonths).toBe(240);
    expect(data.schedule!.effectiveFrom).toBe("2020-01-01");
    expect(data.schedule!.frontiers).toHaveLength(240);

    const first = data.schedule!.frontiers[0]!;
    expect(first.index).toBe(1);
    expect(first.date).toBe("2020-02-01");
    expect(first.openingBalance.amountMinor).toBe(120_000_00);
    // interest = 120000 × 0.03/12 = 300,00 €.
    expect(first.interest.amountMinor).toBe(300_00);
    expect(first.closingBalance.amountMinor).toBe(
      120_000_00 - first.principal.amountMinor,
    );
    // The final cuota closes the loan.
    expect(data.schedule!.frontiers.at(-1)!.closingBalance.amountMinor).toBe(0);
  });

  test("reconciles a faithful loan: the persisted snapshot matches the live recomputation", async () => {
    const store = await freshStore("worthline-agent-view-trace-faithful-");
    await seedLoan(store);
    await captureAt(store, "2021-06-30", "snap_faithful");
    store.close();

    const holdingId = await holdingIdByLabel(await householdScopeId(), "Préstamo");
    const { body } = await trace(holdingId);
    const data = body.data as TraceBody;

    const point = data.reconciliation.find((p) => p.date === "2021-06-30")!;
    expect(point.isSnapshot).toBe(true);
    expect(point.persisted).not.toBeNull();
    // Same config at capture and now → live equals persisted to the cent.
    expect(point.live.amountMinor).toBe(point.persisted!.amountMinor);
    expect(point.difference!.amountMinor).toBe(0);
    expect(point.diverges).toBe(false);

    expect(data.fidelity.faithful).toBe(true);
    expect(data.fidelity.checkedPoints).toBeGreaterThanOrEqual(1);
    expect(data.fidelity.divergences).toHaveLength(0);
  });

  test("surfaces a live-vs-persisted divergence after a mid-cycle early repayment (#1042)", async () => {
    const store = await freshStore("worthline-agent-view-trace-diverge-");
    await seedLoan(store);
    // Freeze the June-2021 balance under the ORIGINAL plan…
    await captureAt(store, "2021-06-30", "snap_diverge");
    // …then record a 30.000 € anticipada dated earlier that year. The live curve
    // now recomputes June 2021 lower than the frozen snapshot — the #1042 class of
    // divergence the trace must make visible rather than hide.
    await store.liabilities.addEarlyRepayment({
      amountMinor: 30_000_00,
      id: "erp_diverge",
      mode: "reduce-payment",
      planId: "plan_loan",
      repaymentDate: "2021-02-01",
    });
    store.close();

    const holdingId = await holdingIdByLabel(await householdScopeId(), "Préstamo");
    const { body } = await trace(holdingId);
    const data = body.data as TraceBody;

    const point = data.reconciliation.find((p) => p.date === "2021-06-30")!;
    expect(point.persisted).not.toBeNull();
    // Live (post-repayment) is well below the frozen (pre-repayment) balance.
    expect(point.live.amountMinor).toBeLessThan(point.persisted!.amountMinor);
    expect(point.difference!.amountMinor).toBeLessThan(0);
    expect(point.diverges).toBe(true);

    expect(data.fidelity.faithful).toBe(false);
    expect(data.fidelity.divergences.length).toBeGreaterThanOrEqual(1);

    // The repayment shows on its frontier in the schedule.
    const lumpFrontier = data.schedule!.frontiers.find((f) => f.date === "2021-02-01")!;
    expect(lumpFrontier.events).toEqual([
      {
        amount: { amountMinor: 30_000_00, currency: "EUR" },
        date: "2021-02-01",
        kind: "early_repayment",
        mode: "reduce-payment",
      },
    ]);
  });

  test("computes the modeling-tolerance band and a declared-figure verdict", async () => {
    const store = await freshStore("worthline-agent-view-trace-tolerance-");
    await seedLoan(store);
    store.close();

    const holdingId = await holdingIdByLabel(await householdScopeId(), "Préstamo");

    // Read the live June-2021 balance first (no snapshot needed) via a declaredDate.
    const { body: baseline } = await trace(holdingId);
    const baseData = baseline.data as TraceBody;
    // Band = max(1 €, 0.05 % of the current balance).
    const expectedBand = Math.max(
      100,
      Math.round(baseData.currentValue.amountMinor * 0.0005),
    );
    expect(baseData.tolerance.band.amountMinor).toBe(expectedBand);
    expect(baseData.tolerance.declared).toBeUndefined();

    // A declared figure one euro off the live balance falls within the band only
    // when the band is at least a euro — which it is for a six-figure loan.
    const declaredMinor = baseData.currentValue.amountMinor + 100;
    const { body: declared } = await trace(
      holdingId,
      `?declaredBalanceMinor=${declaredMinor}`,
    );
    const declaredData = declared.data as TraceBody;
    expect(declaredData.tolerance.declared!.balance.amountMinor).toBe(declaredMinor);
    expect(declaredData.tolerance.declared!.residual.amountMinor).toBe(100);
    expect(declaredData.tolerance.declared!.withinTolerance).toBe(true);

    // A declared figure far off is out of tolerance.
    const wildMinor = baseData.currentValue.amountMinor + 5_000_00;
    const { body: wild } = await trace(holdingId, `?declaredBalanceMinor=${wildMinor}`);
    expect((wild.data as TraceBody).tolerance.declared!.withinTolerance).toBe(false);
  });

  test("still traces a fully-repaid loan (balance 0 today), never a 404", async () => {
    const store = await freshStore("worthline-agent-view-trace-paid-");
    // A 24-month loan disbursed in 2020 is fully repaid long before today, so its
    // live balance is 0 — projectPortfolio drops the zero row, but the holding is
    // owned and still has a cuadro to show.
    await store.liabilities.createLiability({
      balanceMinor: 10_000_00,
      currency: "EUR",
      id: "paid",
      name: "Préstamo saldado",
      ownership: owner,
      type: "debt",
    });
    await store.liabilities.setDebtModel("paid", "amortizable");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.03",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      id: "plan_paid",
      initialCapitalMinor: 10_000_00,
      liabilityId: "paid",
      termMonths: 24,
    });
    store.close();

    // The financial context drops a 0-value liability, so resolve the id directly.
    const reopened = await createWorthlineStoreUnsafe({
      databasePath: process.env.WORTHLINE_DB_PATH!,
    });
    const publicId = (await reopened.agentView.readPublicIds()).find(
      (row) => row.entityType === "holding" && row.entityId === "paid",
    )!.publicId;
    reopened.close();

    const { body, response } = await trace(publicId);
    expect(response.status).toBe(200);
    const data = body.data as TraceBody;
    expect(data.currentValue.amountMinor).toBe(0);
    expect(data.schedule!.frontiers).toHaveLength(24);
    expect(data.schedule!.frontiers.at(-1)!.closingBalance.amountMinor).toBe(0);
  });

  test("traces a revolving liability's balance anchors, with no amortization schedule", async () => {
    const store = await freshStore("worthline-agent-view-trace-revolving-");
    await store.liabilities.createLiability({
      balanceMinor: 5_000_00,
      currency: "EUR",
      id: "card",
      name: "Tarjeta",
      ownership: owner,
      type: "debt",
    });
    await store.liabilities.setDebtModel("card", "revolving");
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2025-01-31",
      balanceMinor: 6_000_00,
      id: "ban_1",
      liabilityId: "card",
    });
    store.close();

    const holdingId = await holdingIdByLabel(await householdScopeId(), "Tarjeta");
    const { body } = await trace(holdingId);
    const data = body.data as TraceBody;

    expect(data.model).toBe("revolving");
    expect(data.schedule).toBeUndefined();
    expect(data.balanceAnchors!.interpolation).toBe("linear");
    expect(data.balanceAnchors!.anchors).toHaveLength(1);
  });

  test("rejects a non-debt holding and a debt with no model with a 422", async () => {
    const store = await freshStore("worthline-agent-view-trace-422-");
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: owner,
      type: "cash",
    });
    await store.liabilities.createLiability({
      balanceMinor: 1_000_00,
      currency: "EUR",
      id: "loose",
      name: "Deuda suelta",
      ownership: owner,
      type: "debt",
    });
    store.close();

    const scopeId = await householdScopeId();
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");
    const looseId = await holdingIdByLabel(scopeId, "Deuda suelta");

    const cash = await trace(cashId);
    expect(cash.response.status).toBe(422);
    expect(cash.body.error.code).toBe("unprocessable_entity");

    const loose = await trace(looseId);
    expect(loose.response.status).toBe(422);
    expect(loose.body.error.code).toBe("unprocessable_entity");
  });

  test("maps malformed query params to documented 400s and requires the token", async () => {
    const store = await freshStore("worthline-agent-view-trace-guard-");
    await seedLoan(store);
    store.close();

    const holdingId = await holdingIdByLabel(await householdScopeId(), "Préstamo");

    for (const query of [
      "?nope=1",
      "?declaredBalanceMinor=abc",
      "?declaredDate=yesterday",
    ]) {
      const { response, body } = await trace(holdingId, query);
      expect(response.status, `expected 400 for ${query}`).toBe(400);
      expect(body.error.code).toBe("bad_request");
    }

    const unauthed = await getTrace(
      new NextRequest(
        `http://127.0.0.1/api/v1/agent-view/holdings/${holdingId}/calculation-trace`,
        { method: "GET" },
      ),
      { params: Promise.resolve({ holdingId }) },
    );
    expect(unauthed.status).toBe(401);
  });

  test("MCP get_calculation_trace mirrors the HTTP envelope", async () => {
    const store = await freshStore("worthline-agent-view-trace-mcp-");
    await seedLoan(store);
    store.close();

    const holdingId = await holdingIdByLabel(await householdScopeId(), "Préstamo");
    const httpBody = (await trace(holdingId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_calculation_trace.invoke({ holdingId });

    expect(mcpBody).toEqual(httpBody);
  });
});
