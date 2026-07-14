import type { AgentViewApiClient } from "@web/agent-view/mcp";
import { createAgentViewMcpToolCatalog } from "@web/agent-view/mcp";
import { GET as getSnapshots } from "@web/api/v1/agent-view/scopes/[scopeId]/snapshots/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createWorthlineStore } from "@worthline/db";
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

async function snapshots(scopeId: string, query = "") {
  const response = await getSnapshots(
    authedRequest(`/api/v1/agent-view/scopes/${scopeId}/snapshots${query}`),
    { params: Promise.resolve({ scopeId }) },
  );
  return { body: await response.json(), response };
}

/**
 * Seed a household scope with one cash asset and a snapshot per given
 * (date, value): capture the valued snapshot at that day's value and persist it,
 * exactly as the daily capture path does. Returns the open helpers' database path
 * via the env var the route handlers read.
 */
async function seedSnapshots(
  points: Array<{ date: string; valueMinor: number }>,
): Promise<void> {
  const databasePath = tempDatabasePath("worthline-agent-view-snap-");
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStore({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: points[0]?.valueMinor ?? 0,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Cuenta corriente",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "cash",
  });

  const workspace = (await store.workspace.readWorkspace())!;
  for (const [index, point] of points.entries()) {
    await store.assets.updateAssetValuation("asset_cash", point.valueMinor);
    const valued = captureValuedNetWorthSnapshot({
      assets: await store.assets.readAssets(),
      capturedAt: `${point.date}T12:00:00.000Z`,
      id: `snapshot_${index}`,
      liabilities: await store.liabilities.readLiabilities(),
      scopeId: "household",
      scopeLabel: "Hogar",
      workspace,
    });
    await store.snapshots.saveSnapshot({
      holdings: valued.holdings,
      snapshot: valued.snapshot,
    });
  }
  store.close();
}

/**
 * Seed one snapshot (2026-06-10) behind a richer portfolio: cash, an investment
 * on the market rung (with frozen units/price), and a home with its mortgage.
 * Captures the valued snapshot the same way the daily path does, freezing the
 * holding rows.
 */
async function seedRichSnapshot(): Promise<void> {
  const databasePath = tempDatabasePath("worthline-agent-view-snap-rich-");
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
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_fund",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: owner,
  });
  await store.command.recordInvestmentOperation(
    {
      assetId: "asset_fund",
      currency: "EUR",
      executedAt: "2026-06-01",
      feesMinor: 0,
      id: "op_buy",
      kind: "buy",
      pricePerUnit: "1500.00",
      units: "10",
    },
    { today: "2026-06-10" },
  );

  const workspace = (await store.workspace.readWorkspace())!;
  const { details } = await store.snapshots.readScopedPositionsWithDetails("household");
  const valued = captureValuedNetWorthSnapshot({
    assets: await store.assets.readAssets(),
    capturedAt: "2026-06-10T12:00:00.000Z",
    id: "snapshot_rich",
    investmentDetails: details,
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
      /^\/api\/v1\/agent-view\/scopes\/([^/]+)\/snapshots$/,
    );
    if (match) {
      const scopeId = decodeURIComponent(match[1]!);
      const response = await getSnapshots(req, {
        params: Promise.resolve({ scopeId }),
      });
      return (await response.json()) as T;
    }

    throw new Error(`Unrouted agent-view path: ${path}`);
  },
};

describe("GET /api/v1/agent-view/scopes/{scopeId}/snapshots", () => {
  test("defaults to monthly closes: the last snapshot of each calendar month", async () => {
    await seedSnapshots([
      { date: "2026-04-30", valueMinor: 100_000_00 },
      { date: "2026-05-15", valueMinor: 110_000_00 },
      { date: "2026-05-31", valueMinor: 120_000_00 },
      { date: "2026-06-10", valueMinor: 130_000_00 },
    ]);

    const { body, response } = await snapshots(await householdScopeId());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    // One entry per month — the last snapshot of each. Mid-May (110k) is dropped.
    const entries = body.data as Array<{
      id: string;
      object: string;
      date: string;
      isMonthlyClose: boolean;
      summary: { netWorth: { amountMinor: number } };
      holdingRows?: unknown;
      holdingRowsSummary?: unknown;
    }>;
    expect(entries.map((e) => e.date)).toEqual([
      "2026-04-30",
      "2026-05-31",
      "2026-06-10",
    ]);
    expect(entries.map((e) => e.summary.netWorth)).toEqual([
      eur(100_000_00),
      eur(120_000_00),
      eur(130_000_00),
    ]);

    for (const entry of entries) {
      expect(entry.id).toMatch(/^wl_snp_[a-f0-9]{32}$/);
      expect(entry.object).toBe("snapshot");
      expect(entry.isMonthlyClose).toBe(true);
      // Holding rows are omitted unless explicitly requested.
      expect(entry.holdingRows).toBeUndefined();
      expect(entry.holdingRowsSummary).toBeUndefined();
    }

    expect(body.meta.limit).toBe(100);
    expect(body.meta.hasNext).toBe(false);
    expect(body.meta.nextCursor).toBeUndefined();
  });

  test("granularity=raw returns every snapshot, flagging each month's close", async () => {
    await seedSnapshots([
      { date: "2026-04-30", valueMinor: 100_000_00 },
      { date: "2026-05-15", valueMinor: 110_000_00 },
      { date: "2026-05-31", valueMinor: 120_000_00 },
      { date: "2026-06-10", valueMinor: 130_000_00 },
    ]);

    const { body } = await snapshots(await householdScopeId(), "?granularity=raw");
    const entries = body.data as Array<{ date: string; isMonthlyClose: boolean }>;

    expect(entries.map((e) => e.date)).toEqual([
      "2026-04-30",
      "2026-05-15",
      "2026-05-31",
      "2026-06-10",
    ]);
    // The last snapshot of each calendar month is its close; mid-May is not.
    expect(entries.map((e) => e.isMonthlyClose)).toEqual([true, false, true, true]);
  });

  test("filters by inclusive from/to date window", async () => {
    await seedSnapshots([
      { date: "2026-04-30", valueMinor: 100_000_00 },
      { date: "2026-05-15", valueMinor: 110_000_00 },
      { date: "2026-05-31", valueMinor: 120_000_00 },
      { date: "2026-06-10", valueMinor: 130_000_00 },
    ]);
    const scopeId = await householdScopeId();

    const window = await snapshots(
      scopeId,
      "?granularity=raw&from=2026-05-01&to=2026-05-31",
    );
    expect((window.body.data as Array<{ date: string }>).map((e) => e.date)).toEqual([
      "2026-05-15",
      "2026-05-31",
    ]);

    // Bounds are inclusive on both ends.
    const onBoundary = await snapshots(
      scopeId,
      "?granularity=raw&from=2026-05-31&to=2026-05-31",
    );
    expect((onBoundary.body.data as Array<{ date: string }>).map((e) => e.date)).toEqual([
      "2026-05-31",
    ]);
  });

  test("sort=-date returns the history newest-first", async () => {
    await seedSnapshots([
      { date: "2026-04-30", valueMinor: 100_000_00 },
      { date: "2026-05-31", valueMinor: 120_000_00 },
      { date: "2026-06-10", valueMinor: 130_000_00 },
    ]);

    const { body } = await snapshots(await householdScopeId(), "?sort=-date");
    expect((body.data as Array<{ date: string }>).map((e) => e.date)).toEqual([
      "2026-06-10",
      "2026-05-31",
      "2026-04-30",
    ]);
  });

  test("paginates with opaque cursors, walking every row exactly once", async () => {
    await seedSnapshots([
      { date: "2026-02-28", valueMinor: 100_000_00 },
      { date: "2026-03-31", valueMinor: 110_000_00 },
      { date: "2026-04-30", valueMinor: 120_000_00 },
      { date: "2026-05-31", valueMinor: 130_000_00 },
      { date: "2026-06-10", valueMinor: 140_000_00 },
    ]);
    const scopeId = await householdScopeId();

    const first = await snapshots(scopeId, "?granularity=raw&limit=2");
    expect((first.body.data as Array<{ date: string }>).map((e) => e.date)).toEqual([
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(first.body.meta.hasNext).toBe(true);
    expect(typeof first.body.meta.nextCursor).toBe("string");
    expect(first.body.links.self).toBe(
      `/api/v1/agent-view/scopes/${scopeId}/snapshots?granularity=raw&limit=2`,
    );
    expect(first.body.links.next).toContain(
      `cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );

    // Follow nextCursor until the history is exhausted, collecting every date.
    const seen: string[] = (first.body.data as Array<{ date: string }>).map(
      (e) => e.date,
    );
    let cursor: string | undefined = first.body.meta.nextCursor;
    let guard = 0;
    while (cursor && guard++ < 10) {
      const page = await snapshots(
        scopeId,
        `?granularity=raw&limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      seen.push(...(page.body.data as Array<{ date: string }>).map((e) => e.date));
      cursor = page.body.meta.hasNext ? page.body.meta.nextCursor : undefined;
    }

    // No row repeated or skipped across pages; full ascending history recovered.
    expect(seen).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-10",
    ]);
  });

  test("clamps limit over the documented maximum to 500", async () => {
    await seedSnapshots([{ date: "2026-06-10", valueMinor: 100_000_00 }]);

    const { body, response } = await snapshots(
      await householdScopeId(),
      "?granularity=raw&limit=9999",
    );
    expect(response.status).toBe(200);
    expect(body.meta.limit).toBe(500);
  });

  test("includeHoldingRows=summary returns a per-rung decomposition", async () => {
    await seedRichSnapshot();

    const { body } = await snapshots(
      await householdScopeId(),
      "?granularity=raw&includeHoldingRows=summary",
    );
    const entry = (
      body.data as Array<{
        holdingRows?: unknown;
        holdingRowsSummary: {
          rowCount: number;
          byLiquidityTier: Array<{
            tier: string;
            grossAssets: { amountMinor: number };
            debts: { amountMinor: number };
            netValue: { amountMinor: number };
          }>;
        };
      }>
    )[0]!;

    // full rows are not included under summary mode.
    expect(entry.holdingRows).toBeUndefined();
    // cash + home + mortgage + investment.
    expect(entry.holdingRowsSummary.rowCount).toBe(4);

    const byTier = Object.fromEntries(
      entry.holdingRowsSummary.byLiquidityTier.map((rung) => [rung.tier, rung]),
    );
    // All five rungs are reported in a stable cash-first order.
    expect(entry.holdingRowsSummary.byLiquidityTier.map((r) => r.tier)).toEqual([
      "cash",
      "market",
      "term-locked",
      "illiquid",
      "housing",
    ]);
    expect(byTier.cash.grossAssets).toEqual(eur(10_000_00));
    expect(byTier.market.grossAssets).toEqual(eur(15_000_00)); // 10 units @ 1500.00
    expect(byTier.housing.grossAssets).toEqual(eur(200_000_00));
    expect(byTier.housing.debts).toEqual(eur(100_000_00));
    expect(byTier.housing.netValue).toEqual(eur(100_000_00));
  });

  test("includeHoldingRows=full returns each frozen row with money and decimals", async () => {
    await seedRichSnapshot();

    const { body } = await snapshots(
      await householdScopeId(),
      "?granularity=raw&includeHoldingRows=full",
    );
    const entry = (
      body.data as Array<{
        holdingRowsSummary?: unknown;
        holdingRows: Array<{
          label: string;
          kind: string;
          liquidityTier: string | null;
          value: { amountMinor: number; currency: string };
          units?: string;
          unitPrice?: string;
          holding?: { id: string; object: string; label: string };
        }>;
      }>
    )[0]!;

    expect(entry.holdingRowsSummary).toBeUndefined();

    const byLabel = Object.fromEntries(entry.holdingRows.map((row) => [row.label, row]));

    // Money stays minor units + currency on every row.
    expect(byLabel["Cuenta"].value).toEqual(eur(10_000_00));
    expect(byLabel["Cuenta"].kind).toBe("asset");
    expect(byLabel["Cuenta"].liquidityTier).toBe("cash");
    expect(byLabel["Cuenta"].holding!.id).toMatch(/^wl_hld_/);
    expect(byLabel["Cuenta"].holding!.object).toBe("holding");
    expect(byLabel["Cuenta"].units).toBeUndefined();

    expect(byLabel["Hipoteca"].kind).toBe("liability");
    expect(byLabel["Hipoteca"].value).toEqual(eur(100_000_00));

    // The investment row carries units as a decimal string; unit price is a
    // decimal string only when a price was known that day (else absent).
    const fund = byLabel["Fondo indexado"];
    expect(fund.kind).toBe("asset");
    expect(fund.value).toEqual(eur(15_000_00));
    expect(fund.units).toBe("10");
    if (fund.unitPrice !== undefined) {
      expect(typeof fund.unitPrice).toBe("string");
    }
  });

  test("maps malformed requests to documented API errors", async () => {
    await seedSnapshots([{ date: "2026-06-10", valueMinor: 100_000_00 }]);
    const scopeId = await householdScopeId();

    const badRequests = [
      "?nope=1", // unknown query parameter
      "?granularity=weekly", // invalid enum
      "?sort=value", // invalid enum
      "?includeHoldingRows=all", // invalid enum
      "?from=2026-13-40", // non-existent calendar date
      "?to=yesterday", // malformed date
      "?limit=0", // below minimum
      "?limit=abc", // non-integer
      "?cursor=not-a-real-cursor", // undecodable cursor
    ];
    for (const query of badRequests) {
      const { response, body } = await snapshots(scopeId, query);
      expect(response.status, `expected 400 for ${query}`).toBe(400);
      expect(body.error.code).toBe("bad_request");
    }

    // Unknown scope → 404 not_found.
    const unknown = await snapshots("wl_scp_doesnotexist");
    expect(unknown.response.status).toBe(404);
    expect(unknown.body.error.code).toBe("not_found");
  });

  test("requires the local capability token", async () => {
    await seedSnapshots([{ date: "2026-06-10", valueMinor: 100_000_00 }]);
    const scopeId = await householdScopeId();

    const response = await getSnapshots(
      new NextRequest(`http://127.0.0.1/api/v1/agent-view/scopes/${scopeId}/snapshots`, {
        method: "GET",
      }),
      { params: Promise.resolve({ scopeId }) },
    );

    expect(response.status).toBe(401);
  });

  test("MCP get_snapshot_history mirrors the HTTP shape and defaults to the household", async () => {
    await seedSnapshots([
      { date: "2026-04-30", valueMinor: 100_000_00 },
      { date: "2026-05-31", valueMinor: 120_000_00 },
      { date: "2026-06-10", valueMinor: 130_000_00 },
    ]);
    const household = await householdScopeId();
    const query = "?granularity=raw&limit=2&includeHoldingRows=summary";
    const httpBody = (await snapshots(household, query)).body;

    const catalog = createAgentViewMcpToolCatalog(routeClient);
    const mcpDefault = await catalog.get_snapshot_history.invoke({
      granularity: "raw",
      includeHoldingRows: "summary",
      limit: 2,
    });
    const mcpExplicit = await catalog.get_snapshot_history.invoke({
      granularity: "raw",
      includeHoldingRows: "summary",
      limit: 2,
      scopeId: household,
    });

    // Omitting scopeId resolves to the household; the MCP envelope is identical
    // to the HTTP envelope (no contract drift) for both forms.
    expect(mcpDefault).toEqual(httpBody);
    expect(mcpExplicit).toEqual(httpBody);
    expect(mcpDefault.meta.hasNext).toBe(true);
  });

  test("reads do not mutate persisted state", async () => {
    await seedRichSnapshot();
    const databasePath = process.env.WORTHLINE_DB_PATH as string;
    const scopeId = await householdScopeId();

    const before = await fingerprint(databasePath);
    await snapshots(scopeId);
    await snapshots(scopeId, "?granularity=raw&includeHoldingRows=full");
    await snapshots(scopeId, "?granularity=raw&includeHoldingRows=summary&limit=1");
    const after = await fingerprint(databasePath);

    expect(after).toBe(before);
  });
});

// A fingerprint of every mutation-prone read, to prove an agent read writes
// nothing (no snapshots, frozen rows, price cache, public IDs, holdings).
async function fingerprint(databasePath: string): Promise<string> {
  const store = await createWorthlineStore({ databasePath });
  const snapshot = JSON.stringify({
    assets: await store.assets.readAssets(),
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
