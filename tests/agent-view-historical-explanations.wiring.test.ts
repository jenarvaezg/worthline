import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getFigureExplanation } from "@web/api/v1/agent-view/scopes/[scopeId]/figure-explanations/[figure]/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";
import {
  captureNetWorthSnapshot,
  captureValuedNetWorthSnapshot,
} from "@worthline/domain";
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

const D1 = "2026-05-10"; // snapshot WITH frozen holding rows
const D2 = "2026-04-10"; // snapshot WITHOUT frozen holding rows (legacy capture)

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

async function explain(scopeId: string, figure: string, query = "") {
  const response = await getFigureExplanation(
    authedRequest(
      `/api/v1/agent-view/scopes/${scopeId}/figure-explanations/${figure}${query}`,
    ),
    { params: Promise.resolve({ figure, scopeId }) },
  );
  return { body: await response.json(), response };
}

async function holdingPublicId(
  databasePath: string,
  internalId: string,
): Promise<string> {
  const store = await createWorthlineStoreUnsafe({ databasePath });
  const publicId = (await store.agentView.readPublicIds()).find(
    (row) => row.entityType === "holding" && row.entityId === internalId,
  )!.publicId;
  store.close();
  return publicId;
}

// A fingerprint of every mutation-prone read, to prove a historical explanation
// read writes nothing (no snapshots, frozen rows, price cache, public IDs, …).
async function fingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStoreUnsafe({ databasePath });
  const snapshot = JSON.stringify({
    assets: await store.assets.readAssets(),
    fireConfig: await store.readFireConfig(),
    liabilities: await store.liabilities.readLiabilities(),
    priceCache: await store.operations.readAllPriceCacheEntries(),
    publicIds: await store.agentView.readPublicIds(),
    snapshotHoldings: await store.snapshots.readSnapshotHoldings({
      scopeId: "household",
    }),
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
    const req = authedRequest(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/agent-view/scopes") {
      return (await (await getScopes(req)).json()) as T;
    }

    const match = url.pathname.match(
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/figure-explanations\/([^/]+)$/,
    );
    if (match) {
      const scopeId = decodeURIComponent(match[1]!);
      const figure = decodeURIComponent(match[2]!);
      const response = await getFigureExplanation(req, {
        params: Promise.resolve({ figure, scopeId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

/**
 * Seed a household with cash, a market fund, a primary residence, and a
 * housing-securing mortgage plus an unsecured loan. Capture a valued snapshot
 * WITH frozen holding rows at D1, and a legacy snapshot WITHOUT holding rows at
 * D2 (headline figures only). Returns the database path.
 */
async function seedHistorical(prefix = "worthline-agent-view-histexp-"): Promise<string> {
  const databasePath = tempDatabasePath(prefix);
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStoreUnsafe({ databasePath });
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
    id: "asset_fund",
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
  await store.liabilities.createLiability({
    balanceMinor: 5_000_00,
    currency: "EUR",
    id: "liab_loan",
    name: "Préstamo",
    ownership: owner,
    type: "debt",
  });

  const workspace = (await store.workspace.readWorkspace())!;

  // D2: a legacy snapshot WITHOUT frozen holding rows (headline figures only).
  const legacy = captureNetWorthSnapshot({
    assets: await store.assets.readAssets(),
    capturedAt: `${D2}T12:00:00.000Z`,
    id: "snapshot_legacy",
    liabilities: await store.liabilities.readLiabilities(),
    scopeId: "household",
    scopeLabel: "Hogar",
    workspace,
  });
  await store.snapshots.saveSnapshot({ snapshot: legacy });

  // D1: a valued snapshot WITH frozen holding rows.
  const valued = captureValuedNetWorthSnapshot({
    assets: await store.assets.readAssets(),
    capturedAt: `${D1}T12:00:00.000Z`,
    id: "snapshot_valued",
    liabilities: await store.liabilities.readLiabilities(),
    scopeId: "household",
    scopeLabel: "Hogar",
    workspace,
  });
  await store.snapshots.saveSnapshot({
    holdings: valued.holdings,
    snapshot: valued.snapshot,
  });

  store.close();
  return databasePath;
}

describe("GET figure-explanations/{figure}?date= (historical, PRD #328 #344)", () => {
  test("net_worth at D1 (with rows) is historical:full, value = the snapshot figure", async () => {
    await seedHistorical("worthline-agent-view-histexp-nw-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "net_worth", `?date=${D1}`);

    expect(response.status).toBe(200);
    expect(body.data.historical).toBe(true);
    expect(body.data.decompositionStatus).toBe("full");
    expect(body.data.asOf).toBe(D1);
    expect(body.data.snapshot.id).toMatch(/^wl_snp_[a-f0-9]{32}$/);
    expect(body.data.snapshot.object).toBe("snapshot");
    expect(body.data.snapshot.date).toBe(D1);
    // grossAssets 230k − debts 105k = 125k.
    expect(body.data.value).toEqual(eur(125_000_00));
    expect(body.data.formula.operands).toEqual([
      { label: "grossAssets", value: eur(230_000_00) },
      { label: "debts", value: eur(105_000_00) },
    ]);

    const includedLabels = body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(includedLabels).toEqual(["Cuenta", "Fondo", "Piso"]);

    const excludedLabels = body.data.excludedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(excludedLabels).toEqual(["Hipoteca", "Préstamo"]);
  });

  test("gross_assets / debts at D1 sum the frozen asset / liability rows", async () => {
    await seedHistorical("worthline-agent-view-histexp-ga-");
    const scopeId = await householdScopeId();

    const ga = await explain(scopeId, "gross_assets", `?date=${D1}`);
    expect(ga.body.data.value).toEqual(eur(230_000_00));
    expect(ga.body.data.decompositionStatus).toBe("full");
    const gaSum = ga.body.data.includedHoldings.reduce(
      (acc: number, h: { value: { amountMinor: number } }) => acc + h.value.amountMinor,
      0,
    );
    expect(gaSum).toBe(230_000_00);

    const debts = await explain(scopeId, "debts", `?date=${D1}`);
    expect(debts.body.data.value).toEqual(eur(105_000_00));
    const debtLabels = debts.body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(debtLabels).toEqual(["Hipoteca", "Préstamo"]);
  });

  test("liquid_net_worth at D1 is liquid frozen assets − liquid non-housing debts", async () => {
    await seedHistorical("worthline-agent-view-histexp-lnw-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "liquid_net_worth", `?date=${D1}`);
    // liquid assets = cash 10k + market 20k = 30k; loan 5k (cash, liquid) nets.
    expect(body.data.value).toEqual(eur(25_000_00));
    expect(body.data.decompositionStatus).toBe("full");
    const includedLabels = body.data.includedHoldings
      .map((h: { holding: { label: string } }) => h.holding.label)
      .sort();
    expect(includedLabels).toEqual(["Cuenta", "Fondo"]);
  });

  test("housing_equity at D1 is frozen housing assets − housing-securing debts", async () => {
    await seedHistorical("worthline-agent-view-histexp-he-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "housing_equity", `?date=${D1}`);
    // home 200k − mortgage 100k = 100k.
    expect(body.data.value).toEqual(eur(100_000_00));
    expect(body.data.decompositionStatus).toBe("full");
    const includedLabels = body.data.includedHoldings.map(
      (h: { holding: { label: string } }) => h.holding.label,
    );
    expect(includedLabels).toEqual(["Piso"]);
  });

  test("liquidity_breakdown at D1 folds the frozen rows per rung", async () => {
    await seedHistorical("worthline-agent-view-histexp-liq-");
    const scopeId = await householdScopeId();

    const { body } = await explain(scopeId, "liquidity_breakdown", `?date=${D1}`);
    expect(body.data.decompositionStatus).toBe("full");
    expect(body.data.historical).toBe(true);
    const rungs = body.data.value as Array<{ tier: string; netValue: unknown }>;
    expect(rungs.map((r) => r.tier)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
    const byTier = Object.fromEntries(rungs.map((r) => [r.tier, r]));
    // cash: account 10k − loan 5k (lands on cash) = 5k.
    expect(byTier.cash.netValue).toEqual(eur(5_000_00));
    // housing: home 200k − mortgage 100k = 100k.
    expect(byTier.housing.netValue).toEqual(eur(100_000_00));
  });

  test("holding_value at D1 returns the frozen row for the holding", async () => {
    const databasePath = await seedHistorical("worthline-agent-view-histexp-hv-");
    const scopeId = await householdScopeId();
    const fundPublic = await holdingPublicId(databasePath, "asset_fund");

    const { body, response } = await explain(
      scopeId,
      "holding_value",
      `?holdingId=${fundPublic}&date=${D1}`,
    );

    expect(response.status).toBe(200);
    expect(body.data.figure).toBe("holding_value");
    expect(body.data.historical).toBe(true);
    expect(body.data.decompositionStatus).toBe("full");
    expect(body.data.value).toEqual(eur(20_000_00));
    expect(body.data.includedHoldings).toHaveLength(1);
    expect(body.data.includedHoldings[0].holding.id).toBe(fundPublic);
  });

  test("the five headline figures at D2 (no rows) are partial + history_coverage", async () => {
    await seedHistorical("worthline-agent-view-histexp-partial-");
    const scopeId = await householdScopeId();

    for (const [figure, expected] of [
      ["net_worth", eur(125_000_00)],
      ["gross_assets", eur(230_000_00)],
      ["debts", eur(105_000_00)],
      ["liquid_net_worth", eur(25_000_00)],
      ["housing_equity", eur(100_000_00)],
    ] as const) {
      const { body, response } = await explain(scopeId, figure, `?date=${D2}`);
      expect(response.status, `200 for ${figure}`).toBe(200);
      expect(body.data.historical, `historical for ${figure}`).toBe(true);
      expect(body.data.decompositionStatus, `partial for ${figure}`).toBe("partial");
      expect(body.data.value, `value for ${figure}`).toEqual(expected);
      expect(body.data.includedHoldings, `no included for ${figure}`).toEqual([]);
      const note = body.data.qualityNotes.find(
        (n: { code: string }) => n.code === "MISSING_SNAPSHOT_ROWS",
      );
      expect(note, `history_coverage note for ${figure}`).toBeDefined();
      expect(note.category).toBe("history_coverage");
    }
  });

  test("liquidity_breakdown at D2 (no rows) is partial + history_coverage", async () => {
    await seedHistorical("worthline-agent-view-histexp-liq-partial-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(
      scopeId,
      "liquidity_breakdown",
      `?date=${D2}`,
    );
    expect(response.status).toBe(200);
    expect(body.data.decompositionStatus).toBe("partial");
    expect(body.data.value).toEqual([]);
    const note = body.data.qualityNotes.find(
      (n: { code: string }) => n.code === "MISSING_SNAPSHOT_ROWS",
    );
    expect(note).toBeDefined();
  });

  test("holding_value at D2 (no rows) is 422 unsupported_figure", async () => {
    const databasePath = await seedHistorical("worthline-agent-view-histexp-hv-partial-");
    const scopeId = await householdScopeId();
    const fundPublic = await holdingPublicId(databasePath, "asset_fund");

    const { body, response } = await explain(
      scopeId,
      "holding_value",
      `?holdingId=${fundPublic}&date=${D2}`,
    );
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.details.reason).toBe("unsupported_figure");
  });

  test("holding_value at D1 for a holding absent that day is 422 unsupported_figure", async () => {
    const databasePath = await seedHistorical("worthline-agent-view-histexp-hv-absent-");
    const scopeId = await householdScopeId();
    // Create a NEW asset after the snapshots so it has a public id but no frozen
    // row at D1.
    const store = await createWorthlineStoreUnsafe({ databasePath });
    await store.assets.createManualAsset({
      currency: "EUR",
      currentValueMinor: 1_000_00,
      id: "asset_late",
      liquidityTier: "cash",
      name: "Tardío",
      ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
      type: "cash",
    });
    store.close();
    const latePublic = await holdingPublicId(databasePath, "asset_late");

    const { response } = await explain(
      scopeId,
      "holding_value",
      `?holdingId=${latePublic}&date=${D1}`,
    );
    expect(response.status).toBe(422);
  });

  test("a date with no exact snapshot is 404 snapshot_not_found", async () => {
    await seedHistorical("worthline-agent-view-histexp-404-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "net_worth", "?date=2026-01-01");
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(body.error.details.reason).toBe("snapshot_not_found");
  });

  test("historical FIRE is 422 unsupported_historical_fire (before snapshot lookup)", async () => {
    await seedHistorical("worthline-agent-view-histexp-fire-");
    const scopeId = await householdScopeId();

    for (const figure of ["fire_eligible_assets", "fire_progress"]) {
      // Use a date with NO snapshot to prove the FIRE guard fires first.
      const { body, response } = await explain(scopeId, figure, "?date=2020-01-01");
      expect(response.status, `422 for ${figure}`).toBe(422);
      expect(body.error.code).toBe("unprocessable_entity");
      expect(body.error.details.reason).toBe("unsupported_historical_fire");
    }
  });

  test("an invalid figure name with a date is still 400 invalid_figure", async () => {
    await seedHistorical("worthline-agent-view-histexp-invalid-");
    const scopeId = await householdScopeId();

    const { body, response } = await explain(scopeId, "not_a_figure", `?date=${D1}`);
    expect(response.status).toBe(400);
    expect(body.error.details.reason).toBe("invalid_figure");
  });

  test("an invalid date format is a 400 bad_request", async () => {
    await seedHistorical("worthline-agent-view-histexp-baddate-");
    const scopeId = await householdScopeId();

    const { response } = await explain(scopeId, "net_worth", "?date=2026-13-40");
    expect(response.status).toBe(400);
  });

  test("historical figures are weighted by the selected member scope", async () => {
    const databasePath = tempDatabasePath("worthline-agent-view-histexp-scopes-");
    process.env.WORTHLINE_DB_PATH = databasePath;
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

    const store = await createWorthlineStoreUnsafe({ databasePath });
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
    const workspace = (await store.workspace.readWorkspace())!;
    for (const scope of ["household", "member_ana", "group_adults"]) {
      const valued = captureValuedNetWorthSnapshot({
        assets: await store.assets.readAssets(),
        capturedAt: `${D1}T12:00:00.000Z`,
        id: `snapshot_${scope}`,
        liabilities: await store.liabilities.readLiabilities(),
        scopeId: scope,
        scopeLabel: scope,
        workspace,
      });
      await store.snapshots.saveSnapshot({
        holdings: valued.holdings,
        snapshot: valued.snapshot,
      });
    }
    store.close();

    const scopes = await listScopes();
    const anaScope = scopes.find(
      (scope) => scope.type === "member" && scope.label === "Ana",
    )!;
    const groupScope = scopes.find((scope) => scope.type === "group")!;

    const anaGa = await explain(anaScope.id, "gross_assets", `?date=${D1}`);
    expect(anaGa.body.data.scope.type).toBe("member");
    expect(anaGa.body.data.value).toEqual(eur(5_000_00));

    const groupGa = await explain(groupScope.id, "gross_assets", `?date=${D1}`);
    expect(groupGa.body.data.scope.type).toBe("group");
    expect(groupGa.body.data.value).toEqual(eur(10_000_00));
  });

  test("MCP explain_figure threads date and mirrors the HTTP historical shape", async () => {
    await seedHistorical("worthline-agent-view-histexp-mcp-");
    const household = await householdScopeId();

    const httpBody = await explain(household, "net_worth", `?date=${D1}`);

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcp = await catalog.explain_figure.invoke({
      date: D1,
      figure: "net_worth",
      scopeId: household,
    });

    expect(mcp).toEqual(httpBody.body);
    expect((mcp as { data: { historical: boolean } }).data.historical).toBe(true);
  });

  test("MCP explain_figure mirrors the 404 snapshot_not_found error", async () => {
    await seedHistorical("worthline-agent-view-histexp-mcp-404-");
    const household = await householdScopeId();

    const httpBody = await explain(household, "net_worth", "?date=2026-01-01");

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcp = await catalog.explain_figure.invoke({
      date: "2026-01-01",
      figure: "net_worth",
      scopeId: household,
    });

    expect(mcp).toEqual(httpBody.body);
    expect((mcp as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "snapshot_not_found",
    );
  });

  test("historical reads do not mutate persisted state", async () => {
    const databasePath = await seedHistorical("worthline-agent-view-histexp-nomut-");
    const scopeId = await householdScopeId();
    const fundPublic = await holdingPublicId(databasePath, "asset_fund");

    const before = await fingerprint(databasePath);
    await explain(scopeId, "net_worth", `?date=${D1}`);
    await explain(scopeId, "liquidity_breakdown", `?date=${D1}`);
    await explain(scopeId, "holding_value", `?holdingId=${fundPublic}&date=${D1}`);
    await explain(scopeId, "gross_assets", `?date=${D2}`);
    await explain(scopeId, "net_worth", "?date=2026-01-01");
    await explain(scopeId, "fire_progress", `?date=${D1}`);
    const after = await fingerprint(databasePath);

    expect(after).toBe(before);
  });
});
