import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";

import { createWorthlineStore } from "@worthline/db";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { GET as getHolding } from "@web/api/v1/agent-view/holdings/[holdingId]/route";
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

/** Resolve a holding's public id by its label via the financial context. */
async function holdingIdByLabel(scopeId: string, label: string): Promise<string> {
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

const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

/** Open a fresh store against a temp DB and initialize a single-member household. */
async function freshStore(): Promise<Awaited<ReturnType<typeof createWorthlineStore>>> {
  const databasePath = tempDatabasePath("worthline-agent-view-facts-");
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStore({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  return store;
}

// An API client that dispatches MCP calls to the real route handlers.
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
      const response = await getHolding(req, {
        params: Promise.resolve({ holdingId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

interface ValuationAnchorFact {
  id: string;
  object: string;
  kind: string;
  date: string;
  value: { amountMinor: number; currency: string };
}

interface HoldingDetailFacts {
  direction: string;
  valuationMethod: string;
  qualitySummary: { hasWarnings: boolean; facts?: string };
  valuationAnchors?: ValuationAnchorFact[];
  amortization?: {
    plan: {
      id: string;
      object: string;
      initialCapital: { amountMinor: number; currency: string };
      annualInterestRate: string;
      termMonths: number;
      disbursementDate: string;
      firstPaymentDate: string;
    };
    interestRateRevisions: Array<{
      id: string;
      object: string;
      date: string;
      annualInterestRate: string;
    }>;
    earlyRepayments: Array<{
      id: string;
      object: string;
      date: string;
      amount: { amountMinor: number; currency: string };
      mode: string;
    }>;
  };
  balanceAnchors?: {
    interpolation: string;
    anchors: Array<{
      id: string;
      object: string;
      date: string;
      balance: { amountMinor: number; currency: string };
    }>;
  };
}

describe("get_holding_detail — appreciating valuation anchors (#338)", () => {
  test("includes valuation anchors distinguishing appraisals from improvements", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: owner,
      type: "real_estate",
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "asset_home",
      id: "van_appraisal",
      valuationDate: "2020-01-01",
      valueMinor: 250_000_00,
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: false,
      assetId: "asset_home",
      id: "van_reform",
      valuationDate: "2022-06-01",
      valueMinor: 20_000_00,
    });
    store.close();

    const scopeId = await householdScopeId();
    const homeId = await holdingIdByLabel(scopeId, "Piso");
    const { body } = await holding(homeId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.direction).toBe("asset");
    expect(detail.valuationMethod).toBe("appreciating");
    expect(detail.valuationAnchors).toHaveLength(2);

    const [appraisal, reform] = detail.valuationAnchors!;
    expect(appraisal).toEqual({
      date: "2020-01-01",
      id: appraisal!.id,
      kind: "market_appraisal",
      object: "valuation_anchor",
      value: eur(250_000_00),
    });
    expect(appraisal!.id).toMatch(/^wl_van_[a-f0-9]{32}$/);
    expect(reform).toEqual({
      date: "2022-06-01",
      id: reform!.id,
      kind: "improvement",
      object: "valuation_anchor",
      value: eur(20_000_00),
    });
    expect(reform!.id).toMatch(/^wl_van_[a-f0-9]{32}$/);
  });

  test("appreciating asset with no anchors → missing_configuration quality note, no fabricated facts", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Piso sin tasaciones",
      ownership: owner,
      type: "real_estate",
    });
    store.close();

    const scopeId = await householdScopeId();
    const homeId = await holdingIdByLabel(scopeId, "Piso sin tasaciones");
    const { body } = await holding(homeId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.valuationMethod).toBe("appreciating");
    expect(detail.valuationAnchors).toBeUndefined();
    expect(detail.qualitySummary.facts).toBe("missing_configuration");
  });

  test("stored asset surfaces no valuation-fact block or fact note", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 10_000_00,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta",
      ownership: owner,
      type: "cash",
    });
    store.close();

    const scopeId = await householdScopeId();
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");
    const { body } = await holding(cashId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.valuationMethod).toBe("stored");
    expect(detail.valuationAnchors).toBeUndefined();
    expect(detail.amortization).toBeUndefined();
    expect(detail.balanceAnchors).toBeUndefined();
    expect(detail.qualitySummary.facts).toBeUndefined();
  });
});

/** Seed a mortgage liability with an amortization plan + a revision + a repayment. */
async function seedAmortizedMortgage(): Promise<void> {
  const store = await freshStore();
  await store.liabilities.createLiability({
    balanceMinor: 180_000_00,
    currency: "EUR",
    id: "liab_mortgage",
    name: "Hipoteca",
    ownership: owner,
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("liab_mortgage", "amortizable");
  await store.liabilities.createAmortizationPlan({
    annualInterestRate: "0.025",
    disbursementDate: "2020-01-01",
    firstPaymentDate: "2020-02-01",
    id: "amp_plan",
    initialCapitalMinor: 200_000_00,
    liabilityId: "liab_mortgage",
    termMonths: 360,
  });
  await store.liabilities.addInterestRateRevision({
    id: "irr_rev",
    newAnnualInterestRate: "0.03",
    planId: "amp_plan",
    revisionDate: "2023-01-01",
  });
  await store.liabilities.addEarlyRepayment({
    amountMinor: 10_000_00,
    id: "erp_lump",
    mode: "reduce-term",
    planId: "amp_plan",
    repaymentDate: "2024-06-01",
  });
  store.close();
}

describe("get_holding_detail — amortized liability facts (#338)", () => {
  test("includes the amortization plan, interest-rate revisions, and early repayments", async () => {
    await seedAmortizedMortgage();
    const scopeId = await householdScopeId();
    const mortgageId = await holdingIdByLabel(scopeId, "Hipoteca");

    const { body } = await holding(mortgageId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.direction).toBe("liability");
    expect(detail.valuationMethod).toBe("amortized");
    expect(detail.valuationAnchors).toBeUndefined();
    expect(detail.balanceAnchors).toBeUndefined();
    expect(detail.qualitySummary.facts).toBeUndefined();

    const amortization = detail.amortization!;
    expect(amortization.plan).toEqual({
      annualInterestRate: "0.025",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      id: amortization.plan.id,
      initialCapital: eur(200_000_00),
      object: "amortization_plan",
      termMonths: 360,
    });
    expect(amortization.plan.id).toMatch(/^wl_amp_[a-f0-9]{32}$/);

    expect(amortization.interestRateRevisions).toEqual([
      {
        annualInterestRate: "0.03",
        date: "2023-01-01",
        id: amortization.interestRateRevisions[0]!.id,
        object: "interest_rate_revision",
      },
    ]);
    expect(amortization.interestRateRevisions[0]!.id).toMatch(/^wl_irr_[a-f0-9]{32}$/);

    expect(amortization.earlyRepayments).toEqual([
      {
        amount: eur(10_000_00),
        date: "2024-06-01",
        id: amortization.earlyRepayments[0]!.id,
        mode: "reduce-term",
        object: "early_repayment",
      },
    ]);
    expect(amortization.earlyRepayments[0]!.id).toMatch(/^wl_erp_[a-f0-9]{32}$/);
  });

  test("amortizable liability with no plan → missing_configuration, no fabricated facts", async () => {
    const store = await freshStore();
    await store.liabilities.createLiability({
      balanceMinor: 50_000_00,
      currency: "EUR",
      id: "liab_loan",
      name: "Préstamo sin plan",
      ownership: owner,
      type: "debt",
    });
    await store.liabilities.setDebtModel("liab_loan", "amortizable");
    store.close();

    const scopeId = await householdScopeId();
    const loanId = await holdingIdByLabel(scopeId, "Préstamo sin plan");
    const { body } = await holding(loanId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.amortization).toBeUndefined();
    expect(detail.balanceAnchors).toBeUndefined();
    expect(detail.qualitySummary.facts).toBe("missing_configuration");
  });

  test("liability with no debt model but a debt-fact instrument → unsupported", async () => {
    const store = await freshStore();
    await store.liabilities.createLiability({
      balanceMinor: 50_000_00,
      currency: "EUR",
      id: "liab_loan",
      name: "Préstamo sin modelo",
      ownership: owner,
      type: "debt",
    });
    store.close();

    const scopeId = await householdScopeId();
    const loanId = await holdingIdByLabel(scopeId, "Préstamo sin modelo");
    const { body } = await holding(loanId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.amortization).toBeUndefined();
    expect(detail.balanceAnchors).toBeUndefined();
    expect(detail.qualitySummary.facts).toBe("unsupported");
  });
});

/** Seed a revolving credit-card liability with two balance anchors. */
async function seedAnchoredCard(model: "revolving" | "informal"): Promise<void> {
  const store = await freshStore();
  await store.liabilities.createLiability({
    balanceMinor: 6_000_00,
    currency: "EUR",
    id: "liab_card",
    name: "Tarjeta",
    ownership: owner,
    type: "debt",
  });
  await store.liabilities.setDebtModel("liab_card", model);
  await store.liabilities.addBalanceAnchor({
    anchorDate: "2024-01-01",
    balanceMinor: 10_000_00,
    id: "ban_jan",
    liabilityId: "liab_card",
  });
  await store.liabilities.addBalanceAnchor({
    anchorDate: "2024-06-01",
    balanceMinor: 6_000_00,
    id: "ban_jun",
    liabilityId: "liab_card",
  });
  store.close();
}

describe("get_holding_detail — anchored liability facts (#338)", () => {
  test("includes balance anchors and linear interpolation for a revolving debt", async () => {
    await seedAnchoredCard("revolving");
    const scopeId = await householdScopeId();
    const cardId = await holdingIdByLabel(scopeId, "Tarjeta");

    const { body } = await holding(cardId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.direction).toBe("liability");
    expect(detail.amortization).toBeUndefined();
    expect(detail.qualitySummary.facts).toBeUndefined();

    const balanceAnchors = detail.balanceAnchors!;
    expect(balanceAnchors.interpolation).toBe("linear");
    expect(balanceAnchors.anchors).toEqual([
      {
        balance: eur(10_000_00),
        date: "2024-01-01",
        id: balanceAnchors.anchors[0]!.id,
        object: "balance_anchor",
      },
      {
        balance: eur(6_000_00),
        date: "2024-06-01",
        id: balanceAnchors.anchors[1]!.id,
        object: "balance_anchor",
      },
    ]);
    for (const anchor of balanceAnchors.anchors) {
      expect(anchor.id).toMatch(/^wl_ban_[a-f0-9]{32}$/);
    }
  });

  test("informal debt uses step interpolation", async () => {
    await seedAnchoredCard("informal");
    const scopeId = await householdScopeId();
    const cardId = await holdingIdByLabel(scopeId, "Tarjeta");

    const { body } = await holding(cardId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.balanceAnchors!.interpolation).toBe("step");
    expect(detail.balanceAnchors!.anchors).toHaveLength(2);
  });

  test("revolving debt with no balance anchors → missing_configuration", async () => {
    const store = await freshStore();
    await store.liabilities.createLiability({
      balanceMinor: 6_000_00,
      currency: "EUR",
      id: "liab_card",
      name: "Tarjeta sin anclas",
      ownership: owner,
      type: "debt",
    });
    await store.liabilities.setDebtModel("liab_card", "revolving");
    store.close();

    const scopeId = await householdScopeId();
    const cardId = await holdingIdByLabel(scopeId, "Tarjeta sin anclas");
    const { body } = await holding(cardId);
    const detail = body.data as HoldingDetailFacts;

    expect(detail.balanceAnchors).toBeUndefined();
    expect(detail.qualitySummary.facts).toBe("missing_configuration");
  });
});

describe("get_holding_detail — facts parity & no mutation (#338)", () => {
  test("MCP get_holding_detail mirrors the HTTP shape for an amortized liability", async () => {
    await seedAmortizedMortgage();
    const scopeId = await householdScopeId();
    const mortgageId = await holdingIdByLabel(scopeId, "Hipoteca");
    const httpBody = (await holding(mortgageId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_holding_detail.invoke({ holdingId: mortgageId });

    expect(mcpBody).toEqual(httpBody);
  });

  test("MCP get_holding_detail mirrors the HTTP shape for an appreciating asset", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: owner,
      type: "real_estate",
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "asset_home",
      id: "van_appraisal",
      valuationDate: "2020-01-01",
      valueMinor: 250_000_00,
    });
    store.close();

    const scopeId = await householdScopeId();
    const homeId = await holdingIdByLabel(scopeId, "Piso");
    const httpBody = (await holding(homeId)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpBody = await catalog.get_holding_detail.invoke({ holdingId: homeId });

    expect(mcpBody).toEqual(httpBody);
  });

  test("reading calculation facts does not mutate persisted state", async () => {
    const store = await freshStore();
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 300_000_00,
      id: "asset_home",
      isPrimaryResidence: true,
      liquidityTier: "illiquid",
      name: "Piso",
      ownership: owner,
      type: "real_estate",
    });
    await store.assets.addValuationAnchor({
      adjustsPriorCurve: true,
      assetId: "asset_home",
      id: "van_appraisal",
      valuationDate: "2020-01-01",
      valueMinor: 250_000_00,
    });
    await store.liabilities.createLiability({
      balanceMinor: 180_000_00,
      currency: "EUR",
      id: "liab_mortgage",
      name: "Hipoteca",
      ownership: owner,
      type: "mortgage",
    });
    await store.liabilities.setDebtModel("liab_mortgage", "amortizable");
    await store.liabilities.createAmortizationPlan({
      annualInterestRate: "0.025",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-01",
      id: "amp_plan",
      initialCapitalMinor: 200_000_00,
      liabilityId: "liab_mortgage",
      termMonths: 360,
    });
    await store.liabilities.addInterestRateRevision({
      id: "irr_rev",
      newAnnualInterestRate: "0.03",
      planId: "amp_plan",
      revisionDate: "2023-01-01",
    });
    await store.liabilities.addEarlyRepayment({
      amountMinor: 10_000_00,
      id: "erp_lump",
      mode: "reduce-term",
      planId: "amp_plan",
      repaymentDate: "2024-06-01",
    });
    await store.liabilities.createLiability({
      balanceMinor: 6_000_00,
      currency: "EUR",
      id: "liab_card",
      name: "Tarjeta",
      ownership: owner,
      type: "debt",
    });
    await store.liabilities.setDebtModel("liab_card", "revolving");
    await store.liabilities.addBalanceAnchor({
      anchorDate: "2024-01-01",
      balanceMinor: 10_000_00,
      id: "ban_jan",
      liabilityId: "liab_card",
    });
    store.close();

    const databasePath = process.env.WORTHLINE_DB_PATH as string;
    const scopeId = await householdScopeId();
    const homeId = await holdingIdByLabel(scopeId, "Piso");
    const mortgageId = await holdingIdByLabel(scopeId, "Hipoteca");
    const cardId = await holdingIdByLabel(scopeId, "Tarjeta");

    const before = await factsFingerprint(databasePath);
    await holding(homeId);
    await holding(mortgageId);
    await holding(cardId);
    const after = await factsFingerprint(databasePath);

    expect(after).toBe(before);
  });
});

// A fingerprint of every dated calculation fact, to prove an agent read writes
// nothing (no anchors, plans, revisions, repayments, or balance anchors changed).
async function factsFingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStore({ databasePath });
  const snapshot = JSON.stringify({
    amortizationPlan: await store.liabilities.readAmortizationPlan("liab_mortgage"),
    balanceAnchors: await store.liabilities.readBalanceAnchors("liab_card"),
    earlyRepayments: await store.liabilities.readEarlyRepayments("amp_plan"),
    interestRateRevisions: await store.liabilities.readInterestRateRevisions("amp_plan"),
    publicIds: await store.agentView.readPublicIds(),
    valuationAnchors: await store.assets.readValuationAnchors("asset_home"),
  });
  store.close();
  return snapshot;
}
